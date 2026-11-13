# M6C-3 — Đối ứng review issue #15

Baseline [f10406c4](https://github.com/shmtoan08/SoftwareFactory/commit/f10406c4e296ea75331b55041e877bc1e8295575) được review ĐẠT. [Issue #15](https://github.com/shmtoan08/SoftwareFactory/issues/15) theo dõi ba ghi chú test-only; không thay đổi production API, kernel/runtime policy hoặc điều kiện Codex production.

## Mapping phần Agent A

| Mục | Thay đổi | Bằng chứng |
| --- | --- | --- |
| S5-NOTE-01 | TC04 bỏ catch rỗng; yêu cầu HTTP400 cho cả oversized health/execute và đọc response body | Cả hai endpoint thực trả400; lỗi transport/reset sẽ reject test thay vì pass. |
| S5-NOTE-02 | TC06 dùng hai request nonce khác nhau, so response nonce với đúng request, tính expected HMAC, so MAC hai lần khác nhau | Replay trả cùng submission, runner chỉ chạy1 lần, journal COMPLETED. |
| S5-NOTE-03 | TC08 thay poll bằng runner-entry event, race với observed request outcome và deadline2s; gắn rejection handler ngay, timeout toàn case10s | Request lỗi trước runner báo lỗi rõ; không vào runner đúng hạn báo timeout; teardown abort/release/await. |

TC03/TC05 kiểm tra status400 theo implementation thay vì chỉ `!ok`. Metadata harness sửa execute request cap192KiB, conflict/HOLD và phân biệt simulated crash với process-death kernel suite.

Truy xuất nguồn B dùng published main commits [14f58fc](https://github.com/shmtoan08/SoftwareFactory/commit/14f58fcf6189cfc43033d729ba141af4ae660668) / [90b2253](https://github.com/shmtoan08/SoftwareFactory/commit/90b225388d36f047a5e25da8980b5ea74ac79acc); local handoff SHAs được ghi rõ là metadata lịch sử.

## Kiểm chứng phần A trước tích hợp

Node24.16 / Darwin: isolation suite20 tests,17 pass/3 kernel skips,0failed; strict TypeScript/lint đạt. TC04/TC06 được chạy riêng và đạt. Production source không cần sửa để lấy HTTP rejection.

Chạy mutation checks một lần trên bản copy tạm của file test, sau mỗi lần xóa bản copy:

- Inject transport reset vào TC04: case FAIL với lỗi reset, exit1 (~0.39s).
- Replay nguyên response cũ vào TC06: FAIL ở assertion response nonce (~0.57s).
- Giữ body nonce mới nhưng trả MAC cũ: FAIL ở HMAC assertion (~0.60s).
- HTTP request A lỗi trước runner-entry: FAIL với `request settled before entering the runner` (~0.41s), không unhandled rejection.
- Trì hoãn health để runner chưa vào đúng hạn: FAIL với `did not enter the runner within 2000ms` (~2.92s gồm teardown).

Đây là expected-failure mutation verification, không tính thành successful feature/kernel tests. Các file mutation chỉ là artifact local, không tồn tại trong test suite chuẩn. Completed CI/source mapping được ghi trong issue15 sau khi merge main; chưa tự tick/đóng issue hay G7.

## Phần Agent B

TAP summary validator và regression tests riêng thực thi contract pass==tests, tests>0 và fail/cancelled/skipped/todo==0; thiếu/malformed/duplicate summary phải fail. A tích hợp commit READY và nối workflow/package scripts sau bàn giao. Kết quả của bản tích hợp xem issue15 và báo cáo TAP riêng, không suy diễn Linux PASS từ các skip Darwin.


## Integrated TAP guard and companion suite

B's handoff691709f is received as commit [bb26320](https://github.com/shmtoan08/SoftwareFactory/commit/bb2632009eacb92e099ce797f4ac8088c6f9ee1a), with29 standalone validator cases. Integration fixes awk precision loss by comparing canonical decimal strings; the integrated suite has32 cases. Ordinary PG regression now includes these32 parser cases alongside the prior145 tests. Strict Linux additionally exercises the existing worker3/3 and independent20-case suites; invalid skipped/cancelled/todo/pass-mismatch/missing-pass fixtures are negative probes, not skipped feature tests.

The same empty-catch and unbounded-wait patterns were removed from A's companion worker-endpoint suite. Both HTTP test helpers now use a5-second request deadline. No production file or runtime policy was modified.
