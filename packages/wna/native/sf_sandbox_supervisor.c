#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <linux/capability.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef PR_SET_CHILD_SUBREAPER
#define PR_SET_CHILD_SUBREAPER 36
#endif

#ifndef PR_SET_NO_NEW_PRIVS
#define PR_SET_NO_NEW_PRIVS 38
#endif

#ifndef _LINUX_CAPABILITY_VERSION_3
#define _LINUX_CAPABILITY_VERSION_3 0x20080522
#endif

static volatile sig_atomic_t g_terminate_requested = 0;
static volatile int g_sig_wake_fd = -1;

static void notify_wake_fd(void) {
  int fd = g_sig_wake_fd;
  if (fd >= 0) {
    int saved = errno;
    char ch = 'w';
    ssize_t ignored = write(fd, &ch, 1);
    (void)ignored;
    errno = saved;
  }
}

static void handle_sigterm(int sig) {
  (void)sig;
  g_terminate_requested = 1;
  notify_wake_fd();
}

static void handle_sigchld(int sig) {
  (void)sig;
  notify_wake_fd();
}

static int write_all_fd(int fd, const void *buf, size_t len) {
  const char *p = (const char *)buf;
  size_t off = 0;
  while (off < len) {
    ssize_t n = write(fd, p + off, len - off);
    if (n < 0) {
      if (errno == EINTR) {
        continue;
      }
      return -1;
    }
    off += (size_t)n;
  }
  return 0;
}

static int write_str_file(const char *path, const char *content) {
  int fd = open(path, O_WRONLY | O_CLOEXEC);
  if (fd < 0) {
    return -1;
  }
  int rc = write_all_fd(fd, content, strlen(content));
  int saved = errno;
  close(fd);
  errno = saved;
  return rc;
}

static char *read_entire_file(const char *path, size_t *out_len) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    return NULL;
  }
  size_t cap = 4096;
  size_t len = 0;
  char *buf = (char *)malloc(cap);
  if (!buf) {
    close(fd);
    return NULL;
  }
  for (;;) {
    if (len + 2048 > cap) {
      if (cap > (size_t)(16 * 1024 * 1024)) {
        free(buf);
        close(fd);
        errno = E2BIG;
        return NULL;
      }
      cap *= 2;
      char *next = (char *)realloc(buf, cap);
      if (!next) {
        free(buf);
        close(fd);
        return NULL;
      }
      buf = next;
    }
    ssize_t n = read(fd, buf + len, cap - len - 1);
    if (n < 0) {
      if (errno == EINTR) {
        continue;
      }
      free(buf);
      close(fd);
      return NULL;
    }
    if (n == 0) {
      break;
    }
    len += (size_t)n;
  }
  close(fd);
  buf[len] = '\0';
  if (out_len) {
    *out_len = len;
  }
  return buf;
}

static void json_write_escaped(FILE *f, const char *s) {
  fputc('"', f);
  if (s) {
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
      unsigned char ch = *p;
      if (ch == '"') {
        fputs("\\\"", f);
      } else if (ch == '\\') {
        fputs("\\\\", f);
      } else if (ch == '\b') {
        fputs("\\b", f);
      } else if (ch == '\f') {
        fputs("\\f", f);
      } else if (ch == '\n') {
        fputs("\\n", f);
      } else if (ch == '\r') {
        fputs("\\r", f);
      } else if (ch == '\t') {
        fputs("\\t", f);
      } else if (ch < 0x20) {
        fprintf(f, "\\u%04x", ch);
      } else {
        fputc(ch, f);
      }
    }
  }
  fputc('"', f);
}

static int atomic_write_file(const char *target_path, const char *content) {
  size_t len = strlen(target_path) + 64;
  char *tmp_path = (char *)malloc(len);
  if (!tmp_path) {
    return -1;
  }
  snprintf(tmp_path, len, "%s.tmp.%ld", target_path, (long)getpid());
  int fd = open(tmp_path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd < 0) {
    free(tmp_path);
    return -1;
  }
  if (write_all_fd(fd, content, strlen(content)) != 0) {
    int saved = errno;
    close(fd);
    unlink(tmp_path);
    free(tmp_path);
    errno = saved;
    return -1;
  }
  close(fd);
  if (rename(tmp_path, target_path) != 0) {
    int saved = errno;
    unlink(tmp_path);
    free(tmp_path);
    errno = saved;
    return -1;
  }
  free(tmp_path);
  return 0;
}

static bool drop_all_caps(void) {
  struct __user_cap_header_struct hdr;
  struct __user_cap_data_struct data[2];
  memset(&hdr, 0, sizeof(hdr));
  memset(data, 0, sizeof(data));
  hdr.version = _LINUX_CAPABILITY_VERSION_3;
  hdr.pid = 0;
  return syscall(SYS_capset, &hdr, data) == 0;
}

static bool resolve_command_in_path(const char *cmd, char *out_path, size_t out_sz) {
  if (!cmd || !cmd[0]) {
    return false;
  }
  if (strchr(cmd, '/') != NULL) {
    char *rp = realpath(cmd, NULL);
    if (!rp) {
      return false;
    }
    size_t len = strlen(rp);
    if (len >= out_sz) {
      free(rp);
      return false;
    }
    memcpy(out_path, rp, len + 1);
    free(rp);
    return true;
  }
  const char *path_env = getenv("PATH");
  if (!path_env || !path_env[0]) {
    path_env = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  }
  char *dup = strdup(path_env);
  if (!dup) {
    return false;
  }
  bool found = false;
  char *saveptr = NULL;
  for (char *dir = strtok_r(dup, ":", &saveptr); dir != NULL;
       dir = strtok_r(NULL, ":", &saveptr)) {
    char candidate[PATH_MAX];
    int n = snprintf(candidate, sizeof(candidate), "%s/%s", dir[0] ? dir : ".", cmd);
    if (n < 0 || (size_t)n >= sizeof(candidate)) {
      continue;
    }
    struct stat st;
    if (stat(candidate, &st) == 0 && S_ISREG(st.st_mode)) {
      char *rp = realpath(candidate, NULL);
      if (rp) {
        size_t len = strlen(rp);
        if (len < out_sz) {
          memcpy(out_path, rp, len + 1);
          found = true;
        }
        free(rp);
      }
      if (found) {
        break;
      }
    }
  }
  free(dup);
  return found;
}

static bool can_other_access_path(const char *path, uid_t target_uid, gid_t target_gid,
                                  bool need_read, bool need_exec) {
  char resolved[PATH_MAX];
  char *rp = realpath(path, NULL);
  if (!rp) {
    return false;
  }
  if (strlen(rp) >= sizeof(resolved)) {
    free(rp);
    return false;
  }
  strcpy(resolved, rp);
  free(rp);

  char prefix[PATH_MAX];
  strcpy(prefix, "/");
  struct stat st;
  if (stat(prefix, &st) != 0) {
    return false;
  }
  if (!(st.st_uid == target_uid ? (st.st_mode & S_IXUSR)
                                : (st.st_gid == target_gid ? (st.st_mode & S_IXGRP)
                                                           : (st.st_mode & S_IXOTH)))) {
    return false;
  }

  size_t len = strlen(resolved);
  for (size_t i = 1; i <= len; i++) {
    if (resolved[i] == '/' || resolved[i] == '\0') {
      bool is_final = (resolved[i] == '\0');
      if (i >= sizeof(prefix)) {
        return false;
      }
      memcpy(prefix, resolved, i);
      prefix[i] = '\0';
      if (stat(prefix, &st) != 0) {
        return false;
      }
      mode_t rbit = (st.st_uid == target_uid) ? S_IRUSR
                    : (st.st_gid == target_gid ? S_IRGRP : S_IROTH);
      mode_t xbit = (st.st_uid == target_uid) ? S_IXUSR
                    : (st.st_gid == target_gid ? S_IXGRP : S_IXOTH);
      if (!is_final) {
        if ((st.st_mode & xbit) == 0) {
          return false;
        }
      } else {
        if (need_read && (st.st_mode & rbit) == 0) {
          return false;
        }
        if (need_exec && (st.st_mode & xbit) == 0) {
          return false;
        }
      }
    }
  }
  return true;
}

static int apply_mount_mask(const char *masked_path) {
  struct stat st;
  if (stat(masked_path, &st) != 0) {
    if (errno == ENOENT) {
      return 1;
    }
    return -1;
  }
  if (S_ISDIR(st.st_mode)) {
    if (mount("tmpfs", masked_path, "tmpfs", MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC,
              "size=4k,mode=000") != 0) {
      return -1;
    }
    return 0;
  }
  if (S_ISREG(st.st_mode)) {
    char tmpdir_tpl[] = "/tmp/.sf-mask-XXXXXX";
    char *mnt = mkdtemp(tmpdir_tpl);
    if (!mnt) {
      return -1;
    }
    if (mount("tmpfs", mnt, "tmpfs", 0, "size=4k,mode=0700") != 0) {
      int saved = errno;
      rmdir(mnt);
      errno = saved;
      return -1;
    }
    char empty_file[64];
    snprintf(empty_file, sizeof(empty_file), "%s/blocked", mnt);
    int fd = open(empty_file, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0000);
    if (fd < 0) {
      int saved = errno;
      umount2(mnt, MNT_DETACH);
      rmdir(mnt);
      errno = saved;
      return -1;
    }
    if (fchmod(fd, 0000) != 0) {
      int saved = errno;
      close(fd);
      umount2(mnt, MNT_DETACH);
      rmdir(mnt);
      errno = saved;
      return -1;
    }
    close(fd);
    int rc = mount(empty_file, masked_path, NULL, MS_BIND, NULL);
    int saved = errno;
    if (rc == 0) {
      if (mount(NULL, masked_path, NULL, MS_BIND | MS_REMOUNT | MS_RDONLY, NULL) != 0) {
        /* best effort read-only remount */
      }
    }
    umount2(mnt, MNT_DETACH);
    rmdir(mnt);
    errno = saved;
    return rc == 0 ? 0 : -1;
  }
  return 1;
}

static int apply_readonly_bind_mount(const char *target_path) {
  struct stat st;
  if (stat(target_path, &st) != 0) {
    return -1;
  }
  if (mount(target_path, target_path, NULL, MS_BIND | MS_REC, NULL) != 0) {
    return -1;
  }
  unsigned long preserve_flags = 0;
  struct statvfs vfs;
  if (statvfs(target_path, &vfs) == 0) {
#ifdef ST_NOSUID
    if (vfs.f_flag & ST_NOSUID) preserve_flags |= MS_NOSUID;
#endif
#ifdef ST_NODEV
    if (vfs.f_flag & ST_NODEV) preserve_flags |= MS_NODEV;
#endif
#ifdef ST_NOEXEC
    if (vfs.f_flag & ST_NOEXEC) preserve_flags |= MS_NOEXEC;
#endif
#ifdef ST_NOATIME
    if (vfs.f_flag & ST_NOATIME) preserve_flags |= MS_NOATIME;
#endif
#ifdef ST_NODIRATIME
    if (vfs.f_flag & ST_NODIRATIME) preserve_flags |= MS_NODIRATIME;
#endif
#ifdef ST_RELATIME
    if (vfs.f_flag & ST_RELATIME) preserve_flags |= MS_RELATIME;
#endif
  }
  if (mount(NULL, target_path, NULL, MS_BIND | MS_REMOUNT | MS_RDONLY | preserve_flags, NULL) != 0) {
    if (mount(NULL, target_path, NULL, MS_BIND | MS_REMOUNT | MS_RDONLY | MS_REC | preserve_flags, NULL) != 0) {
      int saved = errno;
      umount2(target_path, MNT_DETACH);
      errno = saved;
      return -1;
    }
  }
  return 0;
}

typedef struct {
  const char *cgroup_path;
  bool require_cgroup;
  bool isolate_ns;
  bool require_ns;
  bool enable_subreaper;
  bool require_subreaper;
  int drop_privs_mode; /* 0 = never, 1 = auto, 2 = force */
  uid_t target_uid;
  gid_t target_gid;
  const char *cwd;
  const char *ready_file;
  const char *reap_file;
  const char *cmd;
  const char **args;
  size_t arg_count;
  const char **masked_paths;
  size_t mask_count;
  const char **ro_paths;
  size_t ro_path_count;
} SupervisorConfig;

static int parse_nul_config(const char *buf, size_t len, SupervisorConfig *cfg) {
  memset(cfg, 0, sizeof(*cfg));
  cfg->enable_subreaper = true;
  cfg->drop_privs_mode = 1;
  cfg->target_uid = 10020;
  cfg->target_gid = 10020;

  size_t pos = 0;
  size_t args_cap = 0;
  size_t masks_cap = 0;
  size_t ro_cap = 0;
  while (pos < len) {
    const char *key = buf + pos;
    size_t klen = strnlen(key, len - pos);
    pos += klen + 1;
    if (pos > len) {
      break;
    }
    const char *val = buf + pos;
    size_t vlen = strnlen(val, len - pos);
    pos += vlen + 1;

    if (strcmp(key, "cgroup_path") == 0) {
      cfg->cgroup_path = val[0] ? val : NULL;
    } else if (strcmp(key, "require_cgroup") == 0) {
      cfg->require_cgroup = strcmp(val, "1") == 0;
    } else if (strcmp(key, "isolate_ns") == 0) {
      cfg->isolate_ns = strcmp(val, "1") == 0;
    } else if (strcmp(key, "require_ns") == 0) {
      cfg->require_ns = strcmp(val, "1") == 0;
    } else if (strcmp(key, "enable_subreaper") == 0) {
      cfg->enable_subreaper = strcmp(val, "1") == 0;
    } else if (strcmp(key, "require_subreaper") == 0) {
      cfg->require_subreaper = strcmp(val, "1") == 0;
    } else if (strcmp(key, "drop_privs") == 0) {
      cfg->drop_privs_mode = atoi(val);
    } else if (strcmp(key, "uid") == 0) {
      cfg->target_uid = (uid_t)strtoul(val, NULL, 10);
    } else if (strcmp(key, "gid") == 0) {
      cfg->target_gid = (gid_t)strtoul(val, NULL, 10);
    } else if (strcmp(key, "cwd") == 0) {
      cfg->cwd = val;
    } else if (strcmp(key, "ready_file") == 0) {
      cfg->ready_file = val;
    } else if (strcmp(key, "reap_file") == 0) {
      cfg->reap_file = val;
    } else if (strcmp(key, "cmd") == 0) {
      cfg->cmd = val;
    } else if (strcmp(key, "arg") == 0) {
      if (cfg->arg_count == args_cap) {
        args_cap = args_cap ? args_cap * 2 : 16;
        const char **next = (const char **)realloc((void *)cfg->args, args_cap * sizeof(char *));
        if (!next) {
          return -1;
        }
        cfg->args = next;
      }
      cfg->args[cfg->arg_count++] = val;
    } else if (strcmp(key, "mask") == 0) {
      if (cfg->mask_count == masks_cap) {
        masks_cap = masks_cap ? masks_cap * 2 : 8;
        const char **next =
            (const char **)realloc((void *)cfg->masked_paths, masks_cap * sizeof(char *));
        if (!next) {
          return -1;
        }
        cfg->masked_paths = next;
      }
      cfg->masked_paths[cfg->mask_count++] = val;
    } else if (strcmp(key, "ro_path") == 0) {
      if (cfg->ro_path_count == ro_cap) {
        ro_cap = ro_cap ? ro_cap * 2 : 8;
        const char **next =
            (const char **)realloc((void *)cfg->ro_paths, ro_cap * sizeof(char *));
        if (!next) {
          return -1;
        }
        cfg->ro_paths = next;
      }
      cfg->ro_paths[cfg->ro_path_count++] = val;
    }
  }
  if (!cfg->cwd || !cfg->ready_file || !cfg->reap_file || !cfg->cmd) {
    return -1;
  }
  return 0;
}

typedef struct {
  pid_t pid;
  pid_t ppid;
} ProcEntry;

static bool contains_pid(const pid_t *arr, size_t count, pid_t target) {
  for (size_t i = 0; i < count; i++) {
    if (arr[i] == target) {
      return true;
    }
  }
  return false;
}

static size_t collect_proc_descendants(pid_t root_pid, pid_t *out_pids, size_t max_out) {
  DIR *dir = opendir("/proc");
  if (!dir) {
    return 0;
  }
  size_t entries_cap = 256;
  size_t entries_cnt = 0;
  ProcEntry *entries = (ProcEntry *)malloc(entries_cap * sizeof(ProcEntry));
  if (!entries) {
    closedir(dir);
    return 0;
  }

  struct dirent *de;
  while ((de = readdir(dir)) != NULL) {
    if (!isdigit((unsigned char)de->d_name[0])) {
      continue;
    }
    bool all_digits = true;
    for (size_t i = 0; de->d_name[i]; i++) {
      if (!isdigit((unsigned char)de->d_name[i])) {
        all_digits = false;
        break;
      }
    }
    if (!all_digits) {
      continue;
    }
    char stat_path[300];
    int sn = snprintf(stat_path, sizeof(stat_path), "/proc/%s/stat", de->d_name);
    if (sn < 0 || (size_t)sn >= sizeof(stat_path)) {
      continue;
    }
    int fd = open(stat_path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
      continue;
    }
    char buf[1024];
    ssize_t n = read(fd, buf, sizeof(buf) - 1);
    close(fd);
    if (n <= 0) {
      continue;
    }
    buf[n] = '\0';
    char *rparen = strrchr(buf, ')');
    if (!rparen || rparen[1] != ' ' || rparen[2] == '\0') {
      continue;
    }
    char state = 0;
    int ppid_val = 0;
    if (sscanf(rparen + 2, "%c %d", &state, &ppid_val) != 2) {
      continue;
    }
    pid_t pid_val = (pid_t)strtol(de->d_name, NULL, 10);
    if (entries_cnt == entries_cap) {
      entries_cap *= 2;
      ProcEntry *next = (ProcEntry *)realloc(entries, entries_cap * sizeof(ProcEntry));
      if (!next) {
        break;
      }
      entries = next;
    }
    entries[entries_cnt].pid = pid_val;
    entries[entries_cnt].ppid = (pid_t)ppid_val;
    entries_cnt++;
  }
  closedir(dir);

  size_t desc_count = 0;
  bool changed = true;
  while (changed) {
    changed = false;
    for (size_t i = 0; i < entries_cnt; i++) {
      pid_t p = entries[i].pid;
      pid_t pp = entries[i].ppid;
      if (p == root_pid) {
        continue;
      }
      if ((pp == root_pid || contains_pid(out_pids, desc_count, pp)) &&
          !contains_pid(out_pids, desc_count, p)) {
        if (desc_count < max_out) {
          out_pids[desc_count++] = p;
          changed = true;
        }
      }
    }
  }
  free(entries);
  return desc_count;
}

typedef struct {
  bool ns_ok;
  bool user_ns_used;
  bool mask_ok;
  int err_num;
  char reason[256];
} NsProbeResult;

static void probe_ns_in_fork(const char *test_mask_dir, NsProbeResult *out) {
  memset(out, 0, sizeof(*out));
  int sv[2];
  if (pipe2(sv, O_CLOEXEC) != 0) {
    out->err_num = errno;
    snprintf(out->reason, sizeof(out->reason), "pipe failed: %.200s", strerror(errno));
    return;
  }

  pid_t child = fork();
  if (child < 0) {
    out->err_num = errno;
    snprintf(out->reason, sizeof(out->reason), "fork failed: %.200s", strerror(errno));
    close(sv[0]);
    close(sv[1]);
    return;
  }

  if (child == 0) {
    close(sv[0]);
    NsProbeResult r;
    memset(&r, 0, sizeof(r));
    uid_t host_uid = getuid();
    gid_t host_gid = getgid();
    bool is_root = (geteuid() == 0);
    int flags = CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWIPC | CLONE_NEWUTS;
    if (!is_root) {
      flags |= CLONE_NEWUSER;
      r.user_ns_used = true;
    }

    if (unshare(flags) != 0) {
      r.err_num = errno;
      snprintf(r.reason, sizeof(r.reason), "unshare failed: %.200s", strerror(r.err_num));
    } else {
      bool id_ok = true;
      if (r.user_ns_used) {
        (void)write_str_file("/proc/self/setgroups", "deny");
        char mapbuf[64];
        snprintf(mapbuf, sizeof(mapbuf), "0 %lu 1\n", (unsigned long)host_uid);
        if (write_str_file("/proc/self/uid_map", mapbuf) != 0) {
          id_ok = false;
          r.err_num = errno;
          snprintf(r.reason, sizeof(r.reason), "uid_map write failed: %.200s", strerror(r.err_num));
        } else {
          snprintf(mapbuf, sizeof(mapbuf), "0 %lu 1\n", (unsigned long)host_gid);
          if (write_str_file("/proc/self/gid_map", mapbuf) != 0) {
            id_ok = false;
            r.err_num = errno;
            snprintf(r.reason, sizeof(r.reason), "gid_map write failed: %.200s",
                     strerror(r.err_num));
          }
        }
      }
      if (id_ok) {
        if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) {
          r.err_num = errno;
          snprintf(r.reason, sizeof(r.reason), "mount MS_PRIVATE failed: %.200s",
                   strerror(r.err_num));
        } else {
          r.ns_ok = true;
          if (test_mask_dir && test_mask_dir[0]) {
            if (mount("tmpfs", test_mask_dir, "tmpfs",
                      MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, "size=4k,mode=000") == 0) {
              r.mask_ok = true;
            } else {
              r.err_num = errno;
              snprintf(r.reason, sizeof(r.reason), "tmpfs mask mount failed: %.200s",
                       strerror(r.err_num));
            }
          }
        }
      }
    }

    (void)write_all_fd(sv[1], &r, sizeof(r));
    close(sv[1]);
    _exit(0);
  }

  close(sv[1]);
  size_t off = 0;
  char *dst = (char *)out;
  while (off < sizeof(*out)) {
    ssize_t n = read(sv[0], dst + off, sizeof(*out) - off);
    if (n < 0) {
      if (errno == EINTR) {
        continue;
      }
      break;
    }
    if (n == 0) {
      break;
    }
    off += (size_t)n;
  }
  close(sv[0]);
  int st = 0;
  while (waitpid(child, &st, 0) < 0 && errno == EINTR) {
  }
  if (off != sizeof(*out)) {
    memset(out, 0, sizeof(*out));
    out->err_num = EIO;
    snprintf(out->reason, sizeof(out->reason), "probe child exited unexpectedly");
  }
}

static int run_probe(const char *test_mask_dir) {
  bool subreaper_ok = (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) == 0);
  NsProbeResult res;
  probe_ns_in_fork(test_mask_dir, &res);
  bool has_mask_test = (test_mask_dir && test_mask_dir[0]);
  bool ns_supported = res.ns_ok && (!has_mask_test || res.mask_ok);
  printf("{\"subreaperSupported\":%s,\"namespacesSupported\":%s,\"userNamespaceUsed\":%s,"
         "\"mountMaskSupported\":%s,\"reason\":",
         subreaper_ok ? "true" : "false", ns_supported ? "true" : "false",
         res.user_ns_used ? "true" : "false", res.mask_ok ? "true" : "false");
  json_write_escaped(stdout, res.reason);
  fputs("}\n", stdout);
  return 0;
}

static void write_ready_failure(const char *ready_file, const char *err_code, const char *err_msg) {
  char buf[2048];
  FILE *mf = fmemopen(buf, sizeof(buf), "w");
  if (!mf) {
    return;
  }
  fputs("{\"ok\":false,\"errorCode\":", mf);
  json_write_escaped(mf, err_code);
  fputs(",\"errorMessage\":", mf);
  json_write_escaped(mf, err_msg);
  fputs("}\n", mf);
  fclose(mf);
  (void)atomic_write_file(ready_file, buf);
}

static void send_pipe_error(int fd, const char *err_code, const char *err_msg) {
  char line[1024];
  int n = snprintf(line, sizeof(line), "ERR\t%.100s\t%.800s\n", err_code,
                   err_msg ? err_msg : "");
  if (n > 0) {
    size_t len = (size_t)n < sizeof(line) ? (size_t)n : sizeof(line) - 1;
    (void)write_all_fd(fd, line, len);
  }
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "--probe-all") == 0) {
    return run_probe(argc >= 3 ? argv[2] : "");
  }
  if (argc != 3 || strcmp(argv[1], "--config") != 0) {
    fprintf(stderr, "Usage: %s --config <nul-config-file> | --probe-all [mask-dir]\n", argv[0]);
    return 2;
  }

  signal(SIGPIPE, SIG_IGN);

  int sig_pipe[2];
  if (pipe2(sig_pipe, O_CLOEXEC | O_NONBLOCK) != 0) {
    fprintf(stderr, "Failed to create sig_pipe: %s\n", strerror(errno));
    return 2;
  }
  g_sig_wake_fd = sig_pipe[1];

  struct sigaction sa_term;
  memset(&sa_term, 0, sizeof(sa_term));
  sa_term.sa_handler = handle_sigterm;
  sigaction(SIGTERM, &sa_term, NULL);
  sigaction(SIGINT, &sa_term, NULL);

  struct sigaction sa_chld;
  memset(&sa_chld, 0, sizeof(sa_chld));
  sa_chld.sa_handler = handle_sigchld;
  sigaction(SIGCHLD, &sa_chld, NULL);

  size_t cfg_len = 0;
  char *cfg_raw = read_entire_file(argv[2], &cfg_len);
  if (!cfg_raw) {
    fprintf(stderr, "Failed to read config file: %s\n", strerror(errno));
    close(sig_pipe[0]);
    close(sig_pipe[1]);
    return 2;
  }

  SupervisorConfig cfg;
  if (parse_nul_config(cfg_raw, cfg_len, &cfg) != 0) {
    fprintf(stderr, "Invalid NUL supervisor config\n");
    free(cfg_raw);
    close(sig_pipe[0]);
    close(sig_pipe[1]);
    return 2;
  }

  bool subreaper_enabled = false;
  if (cfg.enable_subreaper) {
    if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) == 0) {
      subreaper_enabled = true;
    } else if (cfg.require_subreaper) {
      write_ready_failure(cfg.ready_file, "ERR_LINUX_SUBREAPER_UNAVAILABLE", strerror(errno));
      free((void *)cfg.args);
      free((void *)cfg.masked_paths);
      free((void *)cfg.ro_paths);
      free(cfg_raw);
      close(sig_pipe[0]);
      close(sig_pipe[1]);
      return 1;
    }
  }

  int sync_pipe[2];
  int meta_pipe[2];
  if (pipe2(sync_pipe, O_CLOEXEC) != 0 || pipe2(meta_pipe, O_CLOEXEC) != 0) {
    write_ready_failure(cfg.ready_file, "ERR_SANDBOX_SPAWN_FAILED", strerror(errno));
    free((void *)cfg.args);
    free((void *)cfg.masked_paths);
    free((void *)cfg.ro_paths);
    free(cfg_raw);
    close(sig_pipe[0]);
    close(sig_pipe[1]);
    return 1;
  }

  pid_t c1_pid = fork();
  if (c1_pid < 0) {
    write_ready_failure(cfg.ready_file, "ERR_SANDBOX_SPAWN_FAILED", strerror(errno));
    close(sync_pipe[0]);
    close(sync_pipe[1]);
    close(meta_pipe[0]);
    close(meta_pipe[1]);
    free((void *)cfg.args);
    free((void *)cfg.masked_paths);
    free((void *)cfg.ro_paths);
    free(cfg_raw);
    close(sig_pipe[0]);
    close(sig_pipe[1]);
    return 1;
  }

  if (c1_pid == 0) {
    g_sig_wake_fd = -1;
    close(sig_pipe[0]);
    close(sig_pipe[1]);
    close(sync_pipe[1]);
    close(meta_pipe[0]);
    (void)setpgid(0, 0);

    signal(SIGPIPE, SIG_DFL);
    signal(SIGTERM, SIG_DFL);
    signal(SIGINT, SIG_DFL);
    signal(SIGCHLD, SIG_DFL);

    char go = 0;
    for (;;) {
      ssize_t rn = read(sync_pipe[0], &go, 1);
      if (rn < 0 && errno == EINTR) {
        continue;
      }
      if (rn != 1 || go != 'G') {
        _exit(1);
      }
      break;
    }
    close(sync_pipe[0]);

    bool ns_applied = false;
    bool user_ns_used = false;
    const char **applied_masks = NULL;
    size_t applied_mask_cnt = 0;
    if (cfg.mask_count > 0) {
      applied_masks = (const char **)calloc(cfg.mask_count, sizeof(char *));
    }
    const char **applied_ro_mounts = NULL;
    size_t applied_ro_cnt = 0;
    if (cfg.ro_path_count > 0) {
      applied_ro_mounts = (const char **)calloc(cfg.ro_path_count, sizeof(char *));
    }

    bool host_is_root = (geteuid() == 0);
    uid_t host_uid = getuid();
    gid_t host_gid = getgid();

    if (cfg.isolate_ns) {
      NsProbeResult ns_probe;
      probe_ns_in_fork(NULL, &ns_probe);
      if (!ns_probe.ns_ok) {
        if (cfg.require_ns) {
          const char *msg = ns_probe.reason[0]
                                ? ns_probe.reason
                                : strerror(ns_probe.err_num ? ns_probe.err_num : EPERM);
          send_pipe_error(meta_pipe[1], "ERR_LINUX_NAMESPACE_UNAVAILABLE", msg);
          close(meta_pipe[1]);
          _exit(1);
        }
      } else {
        int ns_flags = CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWIPC | CLONE_NEWUTS;
        if (!host_is_root) {
          ns_flags |= CLONE_NEWUSER;
          user_ns_used = true;
        }
        if (unshare(ns_flags) != 0) {
          send_pipe_error(meta_pipe[1], "ERR_LINUX_NAMESPACE_UNAVAILABLE", strerror(errno));
          close(meta_pipe[1]);
          _exit(1);
        }
        if (user_ns_used) {
          (void)write_str_file("/proc/self/setgroups", "deny");
          char mapbuf[64];
          snprintf(mapbuf, sizeof(mapbuf), "0 %lu 1\n", (unsigned long)host_uid);
          if (write_str_file("/proc/self/uid_map", mapbuf) != 0) {
            send_pipe_error(meta_pipe[1], "ERR_LINUX_NAMESPACE_UNAVAILABLE", strerror(errno));
            close(meta_pipe[1]);
            _exit(1);
          }
          snprintf(mapbuf, sizeof(mapbuf), "0 %lu 1\n", (unsigned long)host_gid);
          if (write_str_file("/proc/self/gid_map", mapbuf) != 0) {
            send_pipe_error(meta_pipe[1], "ERR_LINUX_NAMESPACE_UNAVAILABLE", strerror(errno));
            close(meta_pipe[1]);
            _exit(1);
          }
        }
        if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) {
          send_pipe_error(meta_pipe[1], "ERR_LINUX_NAMESPACE_UNAVAILABLE", strerror(errno));
          close(meta_pipe[1]);
          _exit(1);
        }
        ns_applied = true;
        for (size_t i = 0; i < cfg.mask_count; i++) {
          int mrc = apply_mount_mask(cfg.masked_paths[i]);
          if (mrc == 0 && applied_masks) {
            applied_masks[applied_mask_cnt++] = cfg.masked_paths[i];
          } else if (mrc < 0 && cfg.require_ns) {
            char msg[1024];
            snprintf(msg, sizeof(msg), "Failed to mask %.500s: %.200s", cfg.masked_paths[i],
                     strerror(errno));
            send_pipe_error(meta_pipe[1], "ERR_LINUX_NAMESPACE_UNAVAILABLE", msg);
            close(meta_pipe[1]);
            _exit(1);
          }
        }
        for (size_t i = 0; i < cfg.ro_path_count; i++) {
          int rrc = apply_readonly_bind_mount(cfg.ro_paths[i]);
          if (rrc == 0 && applied_ro_mounts) {
            applied_ro_mounts[applied_ro_cnt++] = cfg.ro_paths[i];
          } else if (rrc < 0 && cfg.require_ns) {
            char msg[1024];
            snprintf(msg, sizeof(msg), "Failed to mount read-only %.500s: %.200s",
                     cfg.ro_paths[i], strerror(errno));
            send_pipe_error(meta_pipe[1], "ERR_LINUX_NAMESPACE_UNAVAILABLE", msg);
            close(meta_pipe[1]);
            _exit(1);
          }
        }
      }
    }

    if (ns_applied) {
      pid_t c2_pid = fork();
      if (c2_pid < 0) {
        send_pipe_error(meta_pipe[1], "ERR_SANDBOX_SPAWN_FAILED", strerror(errno));
        close(meta_pipe[1]);
        _exit(1);
      }
      if (c2_pid > 0) {
        close(meta_pipe[1]);
        int st = 0;
        while (waitpid(c2_pid, &st, 0) < 0 && errno == EINTR) {
        }
        _exit(WIFEXITED(st) ? WEXITSTATUS(st) : (128 + WTERMSIG(st)));
      }

      pid_t c3_pid = fork();
      if (c3_pid < 0) {
        send_pipe_error(meta_pipe[1], "ERR_SANDBOX_SPAWN_FAILED", strerror(errno));
        close(meta_pipe[1]);
        _exit(1);
      }
      if (c3_pid > 0) {
        close(meta_pipe[1]);
        (void)prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
        (void)drop_all_caps();
        int exit_code = 0;
        bool got_c3 = false;
        for (;;) {
          int st = 0;
          pid_t w = waitpid(-1, &st, 0);
          if (w > 0) {
            if (w == c3_pid) {
              got_c3 = true;
              exit_code = WIFEXITED(st) ? WEXITSTATUS(st) : (128 + WTERMSIG(st));
            }
            continue;
          }
          if (w < 0 && errno == EINTR) {
            continue;
          }
          break;
        }
        _exit(got_c3 ? exit_code : 1);
      }
    }

    bool uid_dropped = false;
    if (cfg.drop_privs_mode == 2 && !host_is_root) {
      send_pipe_error(meta_pipe[1], "ERR_SANDBOX_PRIVDROP_FAILED",
                      "Cannot drop UID/GID privileges without CAP_SETUID/root");
      close(meta_pipe[1]);
      _exit(1);
    }
    if (host_is_root && cfg.drop_privs_mode != 0) {
      bool should_drop = false;
      if (cfg.drop_privs_mode == 2) {
        should_drop = true;
      } else if (cfg.drop_privs_mode == 1) {
        char cmd_resolved[PATH_MAX];
        if (resolve_command_in_path(cfg.cmd, cmd_resolved, sizeof(cmd_resolved)) &&
            can_other_access_path(cmd_resolved, cfg.target_uid, cfg.target_gid, false, true) &&
            can_other_access_path(cfg.cwd, cfg.target_uid, cfg.target_gid, true, true)) {
          should_drop = true;
        }
      }
      if (should_drop) {
        if (setgroups(0, NULL) != 0 ||
            setresgid(cfg.target_gid, cfg.target_gid, cfg.target_gid) != 0 ||
            setresuid(cfg.target_uid, cfg.target_uid, cfg.target_uid) != 0) {
          if (cfg.drop_privs_mode == 2) {
            send_pipe_error(meta_pipe[1], "ERR_SANDBOX_PRIVDROP_FAILED", strerror(errno));
            close(meta_pipe[1]);
            _exit(1);
          }
        } else {
          uid_dropped = true;
        }
      }
    }

    bool no_new_privs = (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0);
    bool caps_dropped = drop_all_caps() || uid_dropped;

    if (chdir(cfg.cwd) != 0) {
      send_pipe_error(meta_pipe[1], "ERR_SANDBOX_CHDIR_FAILED", strerror(errno));
      close(meta_pipe[1]);
      _exit(1);
    }

    uid_t effective_uid = user_ns_used ? host_uid : geteuid();
    gid_t effective_gid = user_ns_used ? host_gid : getegid();

    /* Emit partial telemetry suffix; supervisor parent prepends real host workerPid/supervisorPid */
    size_t jcap = 8192 + (cfg.mask_count + cfg.ro_path_count) * 1024;
    char *jbuf = (char *)malloc(jcap);
    if (!jbuf) {
      send_pipe_error(meta_pipe[1], "ERR_SANDBOX_SPAWN_FAILED", "oom");
      close(meta_pipe[1]);
      _exit(1);
    }
    FILE *jf = fmemopen(jbuf, jcap - 1, "w");
    if (jf) {
      fputs("OK\t", jf);
      fprintf(jf, "\"subreaperEnabled\":%s", subreaper_enabled ? "true" : "false");
      fprintf(jf, ",\"uidDropped\":%s", uid_dropped ? "true" : "false");
      fprintf(jf, ",\"actualUid\":%lu", (unsigned long)effective_uid);
      fprintf(jf, ",\"actualGid\":%lu", (unsigned long)effective_gid);
      fprintf(jf, ",\"noNewPrivsEnabled\":%s", no_new_privs ? "true" : "false");
      fprintf(jf, ",\"capabilitiesDropped\":%s", caps_dropped ? "true" : "false");
      fputs(",\"namespaces\":[", jf);
      if (ns_applied) {
        if (user_ns_used) {
          fputs("\"user\",\"mount\",\"pid\",\"ipc\",\"uts\"", jf);
        } else {
          fputs("\"mount\",\"pid\",\"ipc\",\"uts\"", jf);
        }
      }
      fputs("],\"maskedPathsApplied\":[", jf);
      for (size_t i = 0; i < applied_mask_cnt; i++) {
        if (i > 0) {
          fputc(',', jf);
        }
        json_write_escaped(jf, applied_masks[i]);
      }
      fputs("],\"readOnlyMountsApplied\":[", jf);
      for (size_t i = 0; i < applied_ro_cnt; i++) {
        if (i > 0) {
          fputc(',', jf);
        }
        json_write_escaped(jf, applied_ro_mounts[i]);
      }
      fputs("]}\n", jf);
      long pos = ftell(jf);
      fclose(jf);
      if (pos > 0) {
        jbuf[pos] = '\0';
        (void)write_all_fd(meta_pipe[1], jbuf, (size_t)pos);
      }
    }
    free(jbuf);
    free((void *)applied_masks);
    free((void *)applied_ro_mounts);

    char **exec_argv = (char **)calloc(cfg.arg_count + 2, sizeof(char *));
    if (!exec_argv) {
      send_pipe_error(meta_pipe[1], "ERR_SANDBOX_SPAWN_FAILED", "oom");
      close(meta_pipe[1]);
      _exit(1);
    }
    exec_argv[0] = (char *)cfg.cmd;
    for (size_t i = 0; i < cfg.arg_count; i++) {
      exec_argv[i + 1] = (char *)cfg.args[i];
    }
    exec_argv[cfg.arg_count + 1] = NULL;

    execvp(cfg.cmd, exec_argv);
    send_pipe_error(meta_pipe[1], "ERR_SANDBOX_EXEC_FAILED", strerror(errno));
    close(meta_pipe[1]);
    _exit(127);
  }

  close(sync_pipe[0]);
  close(meta_pipe[1]);

  if (cfg.cgroup_path && cfg.cgroup_path[0]) {
    size_t plen = strlen(cfg.cgroup_path) + 32;
    char *procs_path = (char *)malloc(plen);
    char pid_str[32];
    snprintf(pid_str, sizeof(pid_str), "%ld\n", (long)c1_pid);
    int wrc = -1;
    if (procs_path) {
      snprintf(procs_path, plen, "%s/cgroup.procs", cfg.cgroup_path);
      wrc = write_str_file(procs_path, pid_str);
      free(procs_path);
    }
    if (wrc != 0) {
      const char *err_msg = strerror(errno);
      (void)write_all_fd(sync_pipe[1], "X", 1);
      close(sync_pipe[1]);
      close(meta_pipe[0]);
      kill(c1_pid, SIGKILL);
      while (waitpid(c1_pid, NULL, 0) < 0 && errno == EINTR) {
      }
      write_ready_failure(cfg.ready_file, "ERR_LINUX_CGROUP_V2_UNAVAILABLE", err_msg);
      free((void *)cfg.args);
      free((void *)cfg.masked_paths);
      free((void *)cfg.ro_paths);
      free(cfg_raw);
      close(sig_pipe[0]);
      close(sig_pipe[1]);
      return 1;
    }
  }

  (void)write_all_fd(sync_pipe[1], "G", 1);
  close(sync_pipe[1]);

  size_t mcap = 8192;
  size_t mlen = 0;
  char *mbuf = (char *)malloc(mcap);
  if (mbuf) {
    for (;;) {
      if (mlen + 1024 > mcap) {
        mcap *= 2;
        char *next = (char *)realloc(mbuf, mcap);
        if (!next) {
          break;
        }
        mbuf = next;
      }
      ssize_t n = read(meta_pipe[0], mbuf + mlen, mcap - mlen - 1);
      if (n < 0) {
        if (errno == EINTR) {
          continue;
        }
        break;
      }
      if (n == 0) {
        break;
      }
      mlen += (size_t)n;
    }
    mbuf[mlen] = '\0';
  }
  close(meta_pipe[0]);

  const char *ok_suffix = NULL;
  const char *err_line = NULL;
  if (mbuf) {
    char *saveptr = NULL;
    for (char *line = strtok_r(mbuf, "\n", &saveptr); line != NULL;
         line = strtok_r(NULL, "\n", &saveptr)) {
      if (strncmp(line, "ERR\t", 4) == 0) {
        err_line = line + 4;
      } else if (strncmp(line, "OK\t", 3) == 0) {
        ok_suffix = line + 3;
      }
    }
  }

  if (err_line != NULL || ok_suffix == NULL) {
    char err_code[128] = "ERR_SANDBOX_SPAWN_FAILED";
    char err_msg[512] = "Sandbox setup failed before exec";
    if (err_line) {
      const char *tab = strchr(err_line, '\t');
      if (tab) {
        size_t clen = (size_t)(tab - err_line);
        if (clen >= sizeof(err_code)) {
          clen = sizeof(err_code) - 1;
        }
        memcpy(err_code, err_line, clen);
        err_code[clen] = '\0';
        snprintf(err_msg, sizeof(err_msg), "%.500s", tab + 1);
      }
    }
    kill(-c1_pid, SIGKILL);
    kill(c1_pid, SIGKILL);
    for (;;) {
      pid_t w = waitpid(-1, NULL, 0);
      if (w < 0 && errno == EINTR) {
        continue;
      }
      if (w <= 0) {
        break;
      }
    }
    write_ready_failure(cfg.ready_file, err_code, err_msg);
    free(mbuf);
    free((void *)cfg.args);
    free((void *)cfg.masked_paths);
    free((void *)cfg.ro_paths);
    free(cfg_raw);
    close(sig_pipe[0]);
    close(sig_pipe[1]);
    return 1;
  }

  size_t ready_cap = strlen(ok_suffix) + 160;
  char *ready_out = (char *)malloc(ready_cap);
  if (ready_out) {
    snprintf(ready_out, ready_cap, "{\"ok\":true,\"workerPid\":%ld,\"supervisorPid\":%ld,%s\n",
             (long)c1_pid, (long)getpid(), ok_suffix);
    (void)atomic_write_file(cfg.ready_file, ready_out);
    free(ready_out);
  }
  free(mbuf);

  /* Race-free subreaper wait loop using sig_pipe + WNOHANG */
  pid_t reaped_pids[4096];
  size_t reaped_count = 0;
  int main_exit_code = 0;
  bool main_exited = false;

  for (;;) {
    if (g_terminate_requested) {
      break;
    }

    bool saw_echild = false;
    for (;;) {
      int st = 0;
      pid_t w = waitpid(-1, &st, WNOHANG);
      if (w > 0) {
        if (reaped_count < 4096 && !contains_pid(reaped_pids, reaped_count, w)) {
          reaped_pids[reaped_count++] = w;
        }
        if (w == c1_pid) {
          main_exited = true;
          main_exit_code = WIFEXITED(st) ? WEXITSTATUS(st) : (128 + WTERMSIG(st));
        }
        continue;
      }
      if (w < 0 && errno == EINTR) {
        continue;
      }
      if (w < 0 && errno == ECHILD) {
        saw_echild = true;
      }
      break;
    }

    if (saw_echild || g_terminate_requested) {
      break;
    }

    struct pollfd pfd;
    pfd.fd = sig_pipe[0];
    pfd.events = POLLIN;
    pfd.revents = 0;
    int prc = poll(&pfd, 1, 500);
    if (prc > 0 && (pfd.revents & POLLIN)) {
      char drain[64];
      while (read(sig_pipe[0], drain, sizeof(drain)) > 0) {
      }
    }
  }

  if (g_terminate_requested) {
    pid_t my_pid = getpid();
    for (int round = 0; round < 100; round++) {
      if (!main_exited) {
        (void)kill(-c1_pid, SIGKILL);
        (void)kill(c1_pid, SIGKILL);
      }
      pid_t desc[1024];
      size_t desc_cnt = collect_proc_descendants(my_pid, desc, 1024);
      for (size_t i = 0; i < desc_cnt; i++) {
        (void)kill(desc[i], SIGKILL);
      }

      bool echild_seen = false;
      for (;;) {
        int st = 0;
        pid_t w = waitpid(-1, &st, WNOHANG);
        if (w > 0) {
          if (reaped_count < 4096 && !contains_pid(reaped_pids, reaped_count, w)) {
            reaped_pids[reaped_count++] = w;
          }
          if (w == c1_pid) {
            main_exited = true;
            main_exit_code = WIFEXITED(st) ? WEXITSTATUS(st) : (128 + WTERMSIG(st));
          }
          continue;
        }
        if (w < 0 && errno == EINTR) {
          continue;
        }
        if (w < 0 && errno == ECHILD) {
          echild_seen = true;
        }
        break;
      }

      if (desc_cnt == 0 && echild_seen) {
        break;
      }
      struct timespec ts = {0, 15 * 1000 * 1000};
      nanosleep(&ts, NULL);
    }
  }

  struct rusage ru;
  memset(&ru, 0, sizeof(ru));
  unsigned long long cpu_usage_usec = 0ULL;
  unsigned long long peak_memory_bytes = 0ULL;
  if (getrusage(RUSAGE_CHILDREN, &ru) == 0) {
    cpu_usage_usec =
        (unsigned long long)ru.ru_utime.tv_sec * 1000000ULL +
        (unsigned long long)ru.ru_utime.tv_usec +
        (unsigned long long)ru.ru_stime.tv_sec * 1000000ULL +
        (unsigned long long)ru.ru_stime.tv_usec;
    if (ru.ru_maxrss > 0) {
      peak_memory_bytes = (unsigned long long)ru.ru_maxrss * 1024ULL;
    }
  }

  size_t rcap = 65536;
  char *rbuf = (char *)malloc(rcap);
  if (rbuf) {
    FILE *rf = fmemopen(rbuf, rcap - 1, "w");
    if (rf) {
      fputs("{\"reapedPids\":[", rf);
      for (size_t i = 0; i < reaped_count; i++) {
        if (i > 0) {
          fputc(',', rf);
        }
        fprintf(rf, "%ld", (long)reaped_pids[i]);
      }
      fprintf(rf,
              "],\"workerExitCode\":%d,\"cpuUsageUsec\":%llu,\"peakMemoryBytes\":%llu}\n",
              main_exit_code, cpu_usage_usec, peak_memory_bytes);
      long pos = ftell(rf);
      fclose(rf);
      if (pos > 0) {
        rbuf[pos] = '\0';
        (void)atomic_write_file(cfg.reap_file, rbuf);
      }
    }
    free(rbuf);
  }

  free((void *)cfg.args);
  free((void *)cfg.masked_paths);
  free((void *)cfg.ro_paths);
  free(cfg_raw);
  close(sig_pipe[0]);
  close(sig_pipe[1]);
  return main_exit_code;
}
