# M6C-3 bước 5 — Independent worker acceptance tích hợp

Agent B bàn giao commits `7451874` và `06a7edc` dựa trên A `ad0345d`. Agent A nhận hai commit vào branch `m6c3/worker-endpoint`, review test/code và sửa integration harness trước khi chạy Linux CI. Không thay đổi production behavior trong vòng tích hợp này.

## Phạm vi bằng chứng

- 12 adversarial scenarios gọi HTTP endpoint/journal production: MAC/key/identity, strict schema, request limits, deadline, terminal nonce/replay, altered-action conflict, cross-instance claim, HOLD qua các fault-injection boundaries, service-environment payload confinement và traversal rejection.
- Các endpoint cases inject runner emulator bằng constructor flag; không chứng minh kernel isolation. TC09/TC10 dùng hook exceptions + restart server, không được gọi là process death thật. Suite A riêng có child-process death thật và strict Linux native coordinator-death acceptance.
- TC11 kiểm tra canary không vào action/result/journal. Child-process environment được kiểm chứng riêng trong backend test và real Linux concrete runner suite.
- Linux foundation cases chạy subreaper/orphan, mount masking và cgroups kill-and-verify thật. Guard test kiểm tra thiếu capability flags và invalid timeout trên mọi host; nó không giả làm bài execution kernel. UID mapping chỉ kiểm tra tính ổn định và hai fixture IDs, không khẳng định hash không thể collision.

## Đối ứng integration review

1. Đổi strict runner sang TAP reporter cố định; bắt buộc có summary `# tests N`, `# fail 0`, `# skipped 0`. Summary thiếu hoặc có skip bị fail.
2. Harness sử dụng `SF_WORKER_TEST_CGROUP_ROOT` thay vì probe nhầm root mặc định. CI cung cấp subtree riêng đã delegated cpu/memory/pids; script không tự sửa shared cgroup hierarchy.
3. TC08 có assertion trên cả Linux/Darwin, không còn test rỗng trên Linux hoặc ghi skip sau khi chỉ kiểm tra guard validation.
4. TC11 gọi endpoint thật để kiểm tra action/result/journal boundary; không tính helper-only test là endpoint acceptance.
5. Job strict Linux chạy suite A (3 kernel cases), suite B (20 cases) và negative probe chứng minh TAP có skip không thể xanh.

## Chạy kiểm thử

```bash
npm run test:m6c3:worker-isolation
bash scripts/ci/worker-isolation-linux.sh
# Linux root, dedicated delegated subtree đã được operator/CI chuẩn bị:
SF_WORKER_TEST_CGROUP_ROOT=/sys/fs/cgroup/your-dedicated-subtree bash scripts/ci/worker-isolation-linux.sh --strict-linux
```

Local Node24.16 / Darwin: **20 tests, 17 passed, 3 skipped, 0 failed**. Ba skip là kernel cases không có Linux host. Lint/strict TypeScript/shell và secret scan đạt. Chạy strict mode trên Darwin từ chối trước test; không coi relaxed run là bằng chứng Linux.

Kết quả strict Linux, exact source commit, PG16/17 regression và trạng thái review được ghi tại [issue #13](https://github.com/shmtoan08/SoftwareFactory/issues/13) / [PR #14](https://github.com/shmtoan08/SoftwareFactory/pull/14). Không suy diễn no-skip Linux PASS từ local skip. Bàn giao ban đầu ghi 16/4 cho source B; số 17/3 ở đây là bản đã sửa integration guard test, không ghi đè bằng chứng lịch sử đó.

Không có model/cloud thật, VM provisioning hoặc thay đổi chính sách Codex production. M6C/G7 chưa được nghiệm thu bởi các test này; team quyết định checklist/closure.
