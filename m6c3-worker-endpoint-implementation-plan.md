# M6C-3 bước 5 — Kế hoạch worker endpoint và Linux supervisor

Trạng thái: **đang triển khai trên branch Agent A**; endpoint/journal/runner ban đầu đã có, xem [báo cáo implementation](./m6c3-worker-endpoint-validation.md). Independent acceptance và Linux kernel CI còn cần kiểm chứng; chưa nghiệm thu bước 5.

## Baseline và đối ứng review

- `923bfc2c` được review **ĐẠT**; team đã tick 5/5 và đóng [issue #12](https://github.com/shmtoan08/SoftwareFactory/issues/12). [Review commit](https://github.com/shmtoan08/SoftwareFactory/commit/923bfc2c46d620f55bc4c98057cf89a14f4acf64#commitcomment-209714463) không có lỗi nghiêm trọng/trung bình.
- CI exact commit: [43368341332](https://github.com/shmtoan08/SoftwareFactory/actions/runs/43368341332), PG16/17 mỗi job 137/137, native Codex và runsc mỗi job 2/2, không skip.
- Đối ứng ghi chú nhỏ #1: tách điều kiện provenance tại `CoreApiService.verifyMergeCandidate` thành `assignmentMismatch` và `externalPlanWithoutProvenance`, giữ nguyên logic. Review gọi nhầm tên method là `buildMergeCandidateFromGit`; vị trí thực tế nằm trong `verifyMergeCandidate`.
- Ghi chú #2–4 là giới hạn đã công bố: secret detection theo pattern, SENDING không tự redispatch, chưa chạy model/cloud thật. Không thay đổi các chính sách này để đóng review.

## Chọn bước tiếp theo

Ưu tiên hoàn thiện phía server của giao thức execution target trên Linux do operator quản lý. Các HTTP clients Tier 2/3/4 đã có, nhưng chưa có service nhận health/execute và quản lý tiến trình. Phần runner/supervisor dùng chung này tạo nền cho triển khai trong guest Lima/WSL2 sau đó. Đây là thứ tự triển khai đề xuất từ dependency trong source, không phải bổ sung điều kiện nghiệm thu vào đặc tả gốc.

Bước 5 chỉ triển khai endpoint cho `user_managed_worker` (Tier 2); không gắn nhãn service Linux thường thành provider VM hoặc remote vendor session. Tier 3/4 vẫn cần adapter và bằng chứng riêng. Mọi kết quả external tiếp tục bắt buộc network-disabled runsc trước review/approval/CAS.

## Phạm vi triển khai

1. **Service cấu hình bởi operator:** identity/provider/model, dedicated HMAC key, state directory, public baseline registry và runtime adapter qua dependency injection. Namespace tenant được chốt từ cấu hình/key, vì action v1 không mang project ID. Không nhận path, command, credential, URL clone hoặc runtime override từ HTTP caller. Bind loopback/private listener sau TLS proxy cấu hình rõ ràng; mặc định không bật public listener.
2. **Protocol-compatible health/execute:** dùng `sf-target-v1` và `signTargetProtocol` hiện có; strict schema, bounded request/response, canonical UUID/hash/epoch/deadline, timing-safe MAC check trước mọi side effect. Health kiểm tra khả năng kernel/backend thực tế; chỉ quảng cáo capability đã thực thi được. Deadline hết hạn phải bị từ chối trước spawn. Execute v1 đồng bộ phải nằm trong timeout broker hiện tại (mặc định 30 giây, cấu hình tối đa 120 giây); tác vụ dài hơn cần thiết kế protocol async/status riêng, không tự retry hoặc âm thầm tăng timeout trong slice này.
3. **Durable execution journal:** bind namespace + execution ID với hash toàn bộ action; ghi bền claim trước spawn, khóa chống hai coordinator cùng chạy. Cùng ID/action trả trạng thái/kết quả đã lưu; ID trùng nhưng payload khác bị từ chối. Khi restart, claim chưa có terminal proof giữ UNKNOWN/HOLD và không spawn lại. Kết quả terminal lưu DTO/hash; response được ký lại theo nonce request hiện tại, không replay nguyên response/MAC cũ.
4. **Runner trong Linux sandbox:** worktree riêng từ baseline public đã pin commit và do operator nạp sẵn; không fetch URL do caller chọn. Reuse `LinuxCgroupV2SandboxBackend` và contract `AgentRuntimeAdapter`, clean environment, namespace/privilege/resource limits, subreaper, cgroup identity theo execution/epoch. Không truyền HMAC/service/Gateway/DB/Git credentials vào task.
5. **Cleanup trước thành công:** deadline, timeout, disconnect, exception và shutdown phải đi qua kill-and-verify. Chỉ trả successful submission sau khi có terminal execution và bằng chứng cleanup thực: `populated == 0`, reap và remove cgroup. Cleanup không xác minh được thì không trả success. Process death phải có watchdog độc lập và restart reconciliation theo cgroup identity; không coi PID còn/lost là bằng chứng ownership hoặc cleanup.
6. **Artifact output và evidence:** khởi đầu với bounded artifact DTO, regular files trong approved allowed files; không symlink/archive extraction/host path. Core tiếp tục là authority cho protected paths, ancestry/tree validation và import receipt. Wall-time/cleanup evidence lưu ở journal; chưa thêm field response v1 vì client hiện từ chối unknown fields. Ingestion telemetry về Core cần protocol/schema version riêng, không tự coi signed worker declarations là Cost Guard.

## Điểm cần xử lý trước khi nối WNA

`WnaWorkerDaemon.executeLease` hiện yêu cầu `TaskRecord`, `TaskLeaseRecord`, `repoBarePath`, `gitPushToken` và Gateway transport. Payload external v1 chỉ mang PUBLIC context, base commit, allowed files và lease identity/deadline. Vì vậy không bọc thẳng method này bằng HTTP, không dựng task/lease giả và không gửi thêm Factory token để làm đủ tham số.

Tách phần chạy adapter/cleanup dùng chung khỏi Git push/outbox/Gateway orchestration nếu cần, bảo toàn WNA regression hiện hữu. Endpoint trả artifact qua controlled importer thay cho push có Factory credential. Cần kiểm tra riêng baseline immutability và file output boundary trong sandbox; allowed glob không thay thế cô lập filesystem.

Production Codex tiếp tục bị chặn đến khi có Cost Guard đáng tin cậy. Runner acceptance dùng fixed-credential provider-free emulator; Linux process/sandbox phải thật. Không bật một paid opaque runtime chỉ vì health báo provider/model hợp lệ.

## Acceptance cần có

| Nhóm | Bằng chứng bắt buộc |
| --- | --- |
| Protocol/RBAC boundary | Client hiện có gọi server mới; sai MAC/path/nonce/identity/schema/size/deadline và unknown fields đều bị từ chối trước spawn; secret canary không vào child env/log/artifact. |
| Replay/concurrency | Hai process/server instance nhận cùng execution ID chỉ có một spawn; payload khác bị reject; terminal DTO được ký theo nonce mới. |
| Crash/restart | Kill coordinator ở các điểm trước/sau journal claim, trước/sau spawn và trước/sau terminal persist; không respawn claim bất định; restart không giết PID/cgroup không thuộc ownership. |
| Kernel cleanup | Linux cgroups v2 + namespace + subreaper thật; detached/double-fork child, timeout và coordinator death không còn process sau cleanup proof; thiếu delegation/runtime phải fail closed. |
| Import end-to-end | Core broker → HTTP service → real Git workspace + emulator → artifact → controlled receipt; main giữ nguyên; revoke/expiry trong lúc chạy không thể import. |
| Isolation/traceability | Candidate đã import vẫn qua runsc, independent review và human approval/CAS theo pipeline hiện tại; không tự hạ isolation từ metadata worker. |
| Regression | Lint/secret scan; focused endpoint suite; PG16/17 toàn bộ suite; native Codex provider-free và real gVisor jobs giữ nguyên. Emulator tests không thay bằng chứng kernel. |

Một job Linux có quyền cgroup delegation là prerequisite cho kiểm chứng thực; không đánh dấu PASS bằng subprocess fallback. Máy phát triển hiện là Darwin x86_64 và không tìm thấy `limactl`, nên chưa có bằng chứng Lima/WSL2 thật.

## Các bước sau bước 5

1. Lima macOS / WSL2 Windows: adapter lifecycle cho Linux guest, pin instance identity, reuse guest supervisor contract, transfer public baseline/artifact có kiểm soát và chạy isolation suite trên đúng host OS.
2. Concrete Tier 3/4 provider adapters: provisioning/session lifecycle, durable cancellation/fencing, resource accounting và cleanup evidence theo vendor thực tế. Chọn provider khi tới phần này, chưa tạo tài nguyên trả phí trong bước chuẩn bị.
3. Firecracker/microVM: xác định mức bắt buộc theo phạm vi nghiệm thu còn lại, triển khai và kiểm chứng riêng nếu theo roadmap; không coi gVisor test là bằng chứng microVM.
4. Gate G7: tổng hợp acceptance M6C-1/2/3 và phần còn thiếu, chỉ đề nghị team nghiệm thu khi đầy đủ bằng chứng. Không tự đóng gate.
