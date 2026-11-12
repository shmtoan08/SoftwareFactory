#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <errno.h>

/* Keep the inode permanent. Kernel ownership ends on helper exit or parent EOF. */
int main(int argc, char **argv) {
  if (argc != 2) return 64;
  int fd = open(argv[1], O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
  if (fd < 0) return 74;
  struct stat info;
  if (fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_nlink != 1) return 74;
  if (flock(fd, LOCK_EX | LOCK_NB)) return errno == EWOULDBLOCK ? 75 : 74;
  if (ftruncate(fd, 0) || dprintf(fd, "kernel-flock-v1 pid=%ld\n", (long)getpid()) < 0) return 74;
  puts("LOCKED"); fflush(stdout);
  char input[32];
  while (read(STDIN_FILENO, input, sizeof(input)) > 0) {}
  close(fd);
  return 0;
}
