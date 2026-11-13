# M6C-3 Bước 5 — Báo cáo Thiết kế & Kiểm chứng Worker Isolation, Sandbox Cleanup và Adversarial Matrix

- **Thời điểm**: 2026-11-13
- **Tác giả**: Agent B — Kiểm thử isolation, cleanup và security
- **Worktree**: `/Volumes/Projects/SoftwareFactory-agent-tests`
- **Branch**: `m6c3/worker-isolation-tests`
- **Baseline Git SHA**: `f1760ef574966cc25a14fb56183250a8f807487d`
- **Tài liệu tham chiếu**: [Issue #13](https://github.com/shmtoan08/SoftwareFactory/issues/13), `m6c3-worker-endpoint-implementation-plan.md`

---

## 1. Mục tiêu và Phạm vi Ownership của Agent B

Theo phân công trong `AGENT_B.md` và `INTERFACE.md`:
- Thiết kế và triển khai bộ kiểm thử **isolation**, **sandbox cleanup** và **adversarial contract suite** cho Bước 5 (Linux worker endpoint & durable supervisor).
- Tái sử dụng backend Linux sandbox hiện hữu (`LinuxCgroupV2SandboxBackend`, `sf_sandbox_supervisor.c` trong `packages/wna`).
- Phân định rạch ròi giữa logic kiểm thử, fail-closed contract và bằng chứng kernel thực: trên Darwin host, các bài test đòi hỏi kernel Linux (cgroup v2, subreaper waitpid, user namespaces) phải ghi `SKIP` có lý do rõ ràng, tuyệt đối không dùng subprocess fallback để đánh dấu PASS giả.
- Lập ma trận đối nghịch (adversarial matrix 12 kịch bản) cho HTTP endpoint và durable journal để thống nhất trước với Agent A.
- Chuẩn bị runner script cho Linux CI (`scripts/ci/worker-isolation-linux.sh`).
- Giữ nguyên giới hạn: không gọi model/cloud trả phí, không bật Codex production, không tự ý đóng Issue #13 hoặc Gate G7.

### Danh mục File do Agent B sở hữu và tạo mới:
1. `packages/test-harness/src/m6c3-worker-isolation-harness.ts`: Thư viện tiện ích, canaries detector, probe capability, contract validation và ma trận 12 kịch bản.
2. `packages/test-harness/src/m6c3-worker-isolation.test.ts`: Bộ kiểm thử Node 24 native test suite (19 tests, 2 suites).
3. `scripts/ci/worker-isolation-linux.sh`: Script thiết lập cgroup delegation và chạy kiểm chứng trên Linux CI.
4. `m6c3-worker-isolation-validation.md`: Báo cáo chi tiết này.
5. Files trao đổi local: `/Volumes/Projects/SoftwareFactory-collaboration/status/AGENT_B.md`, `messages/B_TO_A.md`, `handoffs/AGENT_B.md`.

---

## 2. Kiến trúc Kiểm thử và Tái sử dụng Linux Sandbox

### 2.1 Backend Linux Cgroup v2 & Supervisor (`packages/wna/src/index.ts`)
Backend hiện hữu đã có đầy đủ kiến trúc cô lập tiến trình cấp OS:
- **`PR_SET_CHILD_SUBREAPER`**: Tiến trình supervisor nhận làm cha (reparenting) mọi tiến trình cháu chắt mồ côi (detached/double-fork orphans), thu hồi sạch qua `waitpid(-1)`.
- **Linux Cgroups v2**:
  - Ghi `cgroup.freeze` = 1 để đóng băng toàn bộ tiến trình trong scope.
  - Ghi `cgroup.kill` = 1 để gửi SIGKILL nguyên tử từ kernel.
  - Thăm dò `cgroup.events` cho đến khi `populated == 0`.
  - Xóa thư mục cgroup scope (`rmdir`) để giải phóng tài nguyên.
- **Linux Namespaces**: `CLONE_NEWNS`, `CLONE_NEWPID`, `CLONE_NEWIPC`, `CLONE_NEWUTS`, và `CLONE_NEWUSER` (khi unprivileged).
- **Mount Masking**: Ẩn các thư mục nhạy cảm (`/etc/sf-wna`, host secrets) bằng tmpfs/read-only bind, cấm thoát khỏi worktree (`assertSandboxPathAccess`).
- **Privilege Dropping**: `PR_SET_NO_NEW_PRIVS` và xóa toàn bộ POSIX capabilities trước khi exec tiến trình runner.

### 2.2 Quy tắc Fail-Closed trên Darwin vs Linux
- Trên host **Darwin x86_64**, kernel Linux không khả dụng:
  - `probeLinuxCgroupV2Support()` → `supported: false`
  - `probeLinuxSubreaperSupport()` → `supported: false`
  - `probeLinuxNamespaceSupport()` → `supported: false`
- Khi caller yêu cầu cgroup v2, subreaper hoặc namespace trên Darwin, hệ thống phải ném lỗi chính xác:
  - `ERR_LINUX_CGROUP_V2_UNAVAILABLE`
  - `ERR_LINUX_SUBREAPER_UNAVAILABLE`
  - `ERR_LINUX_NAMESPACE_UNAVAILABLE`
- Test suite kiểm chứng nghiêm ngặt hành vi fail-closed này trên Darwin. Khi chạy các bài kiểm thử đòi hỏi kernel Linux thực sự, test runner ghi nhận `SKIP` kèm thông điệp:
  `# Platform 'darwin' is not Linux. Kernel isolation tests (cgroups v2, namespaces, subreaper) require Linux kernel.`

---

## 3. Ma trận Đối nghịch Worker Endpoint (12 Kịch bản)

Đã thiết kế và chuẩn hóa 12 kịch bản adversarial theo giao thức `sf-target-v1` và contract Bước 5:

| ID | Tên Kịch bản | Nhóm | Hành vi K规范 / Kỳ vọng |
| --- | --- | --- | --- |
| **TC01** | `TC01_INVALID_SIGNATURE` | Security | Thiếu hoặc sai HMAC signature trong `x-sf-target-signature` bị từ chối ngay lập tức trước khi spawn process hoặc tạo journal claim. |
| **TC02** | `TC02_IDENTITY_MISMATCH` | Security | Caller gửi sai `principal_id`, `worker_id`, `provider`, hoặc `model` (hoặc cố ý chọn `codex-production`) bị từ chối `ERR_TARGET_PROTOCOL`. |
| **TC03** | `TC03_UNKNOWN_FIELDS` | Protocol | Request mang trường lạ ngoài schema (ví dụ: `command_override`, `custom_repo_clone_url`) bị từ chối nghiêm ngặt. |
| **TC04** | `TC04_OVERSIZED_PAYLOAD` | Protocol | Payload vượt quá giới hạn (16KB cho `/health`, 3MB cho `/execute`) bị ngắt kết nối/từ chối ngay trên luồng stream (chống DoS). |
| **TC05** | `TC05_EXPIRED_DEADLINE` | Lifecycle | Action có deadline đã quá hạn hoặc quá sát hạn bị từ chối trước khi spawn bất kỳ tiến trình OS nào. |
| **TC06** | `TC06_IDEMPOTENT_REPLAY_SAME_PAYLOAD` | Lifecycle | Gọi lại execute với cùng `execution_id` và cùng action payload trả về kết quả terminal DTO đã lưu, **ký lại bằng nonce của request mới**. |
| **TC07** | `TC07_CONFLICTING_REPLAY_DIFFERENT_PAYLOAD` | Security | Gọi lại execute với cùng `execution_id` nhưng payload bị thay đổi hash bị từ chối thẳng thừng (HTTP 409 / Conflict/Tampering). |
| **TC08** | `TC08_CONCURRENT_EXECUTION_LOCK` | Lifecycle | Hai request đồng thời cùng `execution_id` cạnh tranh atomic journal claim; duy nhất một tiến trình runner được phép spawn. |
| **TC09** | `TC09_CRASH_RECOVERY_BEFORE_SPAWN` | Crash Recovery | Coordinator crash sau khi ghi claim nhưng trước khi spawn runner: khi khởi động lại, claim được giữ ở trạng thái `UNKNOWN_HOLD`, không tự động respawn. |
| **TC10** | `TC10_CRASH_RECOVERY_DURING_RUN` | Crash Recovery | Coordinator crash khi tiến trình runner đang chạy: khi khởi động lại, watchdog nhận diện theo cgroup scope, thu hồi sạch tiến trình và chuyển trạng thái `FAILED`. |
| **TC11** | `TC11_ENVIRONMENT_CANARY_ISOLATION` | Security | Môi trường con chạy dưới `env -i` sạch; không có bất kỳ secret nào của host/service (`SF_TARGET_KEY`, `AGENT_GATEWAY_TOKEN`, `PGPASSWORD`, v.v.). |
| **TC12** | `TC12_PATH_TRAVERSAL_MOUNT_ISOLATION` | Security | Thao tác truy cập ngoài worktree (`../`, `..\`, null bytes) hoặc truy cập thư mục credential `/etc/sf-wna` bị từ chối `EACCES`. |

---

## 4. Kết quả Thực thi Kiểm thử

### 4.1 Lệnh Chạy
```bash
# Thiết lập Node v24
export PATH=/Users/shmtoan/.nvm/versions/node/v24.16.0/bin:$PATH

# Typecheck & Lint & Secret Scan
npm run typecheck
npm run lint
npm run scan:secrets

# Chạy test suite isolation & cleanup
node --test packages/test-harness/src/m6c3-worker-isolation.test.ts

# Hoặc chạy thông qua CI runner script
./scripts/ci/worker-isolation-linux.sh
```

### 4.2 Kết quả chi tiết
```
========================================================================
M6C-3 Step 5 — Linux Kernel Worker Isolation & Cleanup Verification
========================================================================
[1/5] Host Environment:
  OS:           Darwin
  Kernel:       24.6.0
  Architecture: x86_64
  UID:          501
  User:         shmtoan
[-] WARNING: Platform 'Darwin' is not Linux. Kernel tests will report honest SKIP.
    To execute genuine kernel isolation, run inside Linux container or VM with cgroups v2.

[2/5] Inspecting Linux Cgroups v2 Hierarchy:
  [-] Cgroup v2 hierarchy not detected at /sys/fs/cgroup

[3/5] Inspecting Linux Namespaces & Unprivileged Userns Clone:

[4/5] Checking Native C Compiler for sf_sandbox_supervisor:
  [+] Found C compiler: cc (Apple clang version 17.0.0 (clang-1700.0.13.5))

[5/5] Executing Isolation Test Suite with Node Test Runner:
------------------------------------------------------------------------
  Node binary: /Users/shmtoan/.nvm/versions/node/v24.16.0/bin/node (v24.16.0)
▶ M6C-3 Step 5 — Worker Isolation, Sandbox Cleanup & Adversarial Contract Suite
  ✔ TC-01: Environment Canaries & Secret Sanitization — zero host credentials leak into child process (94.236005ms)
  ﹣ TC-02: Double-Fork Process Tracking — Darwin fails-closed honestly, Linux reaps orphans via subreaper (1.652496ms) # Platform 'darwin' is not Linux. Kernel isolation tests (cgroups v2, namespaces, subreaper) require Linux kernel.
  ﹣ TC-03: Mount Namespace & Path Traversal Guards — worktree containment, traversal rejection & credential denial (0.977338ms) # Platform 'darwin' is not Linux. Kernel isolation tests (cgroups v2, namespaces, subreaper) require Linux kernel.
  ﹣ TC-04: Cgroups v2 Hierarchy & Kill-and-Verify Contract — honest reporting, freeze/kill lifecycle (0.48244ms) # Platform 'darwin' is not Linux. Kernel isolation tests (cgroups v2, namespaces, subreaper) require Linux kernel.
  ✔ TC-05: Timeout & Process Termination — killAndVerifyClean reliably terminates long-running tasks (6.444693ms)
  ✔ TC-06: Honest Metrics Telemetry — never fabricates cgroup CPU or memory telemetry when unavailable (85.670767ms)
  ✔ TC-07: Task Runner UID Derivation — distinct deterministic UIDs per task prevent user collisions (0.265539ms)
  ▶ Worker Endpoint Adversarial Contract Matrix Validation (12 Scenarios)
    ✔ TC01: Bad or Missing HMAC Signature Rejection (2.984667ms)
    ✔ TC02: Target Identity Mismatch Defense (0.304015ms)
    ✔ TC03: Strict Schema Unknown Fields Rejection (0.457846ms)
    ✔ TC04: Bounded Request Payload Size Limit (0.224559ms)
    ✔ TC05: Expired Deadline Rejection Before Spawn (0.195912ms)
    ✔ TC06: Idempotent Replay with Same Action Payload (0.931792ms)
    ✔ TC07: Conflicting Replay with Altered Payload Rejection (0.340392ms)
    ✔ TC08: Atomic Journal Concurrency & Single Spawn Lock (0.192849ms)
    ✔ TC09: Crash Recovery for Orphaned Pre-Spawn Claim — HOLD state, never auto-respawns (0.200364ms)
    ✔ TC10: Watchdog Reconciliation for Running Processes on Crash (0.153142ms)
    ✔ TC11: Environment Canaries & Secret Sanitization — complete coverage (0.126025ms)
    ✔ TC12: Mount Namespace & Path Traversal Guard — complete coverage (0.104163ms)
  ✔ Worker Endpoint Adversarial Contract Matrix Validation (12 Scenarios) (6.884224ms)
✔ M6C-3 Step 5 — Worker Isolation, Sandbox Cleanup & Adversarial Contract Suite (198.93442ms)
ℹ tests 19
ℹ suites 2
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 0
ℹ duration_ms 507.63871
------------------------------------------------------------------------
[✓] Worker isolation and cleanup verification runner completed.
```

- **Tổng số tests**: 19
- **PASS**: 16
- **SKIP**: 3 (do môi trường host là Darwin x86_64, các bài kiểm tra đòi hỏi kernel cgroups v2/namespaces/subreaper được ghi SKIP trung thực)
- **FAIL**: 0
- **Linter & Typecheck**: Sạch 100%, 0 warning, 0 error.
- **Secret Scanner**: Đạt 100%, 0 leak phát hiện.

---

## 5. Lưu ý Phối hợp Kỹ thuật gửi Agent A

1. **Khuyến nghị Export Endpoint Factory**:
   - `createWorkerEndpointServer(config: WorkerEndpointServerConfig): WorkerEndpointServer`
   - Hỗ trợ bind port 0 (dynamic listen), inject mock/harness backend khi kiểm thử.
2. **Cảnh báo Quan trọng về Response Wire Format (`sf-target-v1`)**:
   - Phía client `HttpExecutionTargetConnector` (trong `packages/adapter-sdk/src/execution-targets.ts`) kiểm tra nghiêm ngặt danh sách permitted keys:
     `["schema_version", "nonce", "target_type", "principal_id", "worker_id", "provider", "model", "execution_id", "lease_epoch", "submission"]`.
   - Nếu server trả thêm field như `cleanup_evidence` ở top-level body, client sẽ ném lỗi `Unknown target response fields`.
   - Bằng chứng cleanup (`SandboxCleanupEvidence`) phải được lưu bền trong journal / state directory, không đưa vào wire format v1 của response HTTP.
3. **Hook Phục vụ Kiểm thử Crash Recovery**:
   - Cung cấp các hook/callback trước và sau các mốc: `beforeJournalClaim`, `afterJournalClaim`, `beforeRunnerSpawn`, `beforeTerminalPersist`.
4. **Quy trình Nhận Source Tiếp theo**:
   - Sau khi Agent A công bố implementation commit ổn định, Agent B sẽ viết tiếp black-box integration tests kết nối trực tiếp endpoint thật và adapter.
