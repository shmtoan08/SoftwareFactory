# Software Factory — Đặc tả Kỹ thuật M6A: Model Provider Adapter, Cost Guard (`AC-12b`) & Stages 1–4 Product Pipeline (`M6A_SPEC.md`)

- **Mã tài liệu:** `M6A-SPEC-01`
- **Phiên bản:** 1.5
- **Trạng thái:** Ready for Milestone `M6A` Implementation (Mở khóa sau khi `M5` PASS 100%)
- **Tham chiếu:** [Development Roadmap v1.5](./software-factory-development-roadmap.md) (`M6A`, `P1-8`) · [System Design Plan v1.5](./software-factory-design-plan.md) (`§1.2`, `AC-01`, `AC-10`, `AC-12b`) · [`MVP_DATABASE_AND_RLS_SPEC.md`](./mvp_database_schema_and_rls_specification_v1_5.md)
- **Phạm vi:** Chuẩn hóa thiết kế kỹ thuật chi tiết cho:
  1. **Model Provider Adapter v2** (`anthropic`, `openai`, `gemini/google`) hỗ trợ hoán đổi bằng cấu hình ($\ge 2$ providers).
  2. **Prompt Versioning & Deterministic Prompt Registry**.
  3. **Strict Structured Output JSON Schema Validation** (`Fail-Closed`).
  4. **Per-Request & Session Token/Cost Guard (`AC-12b`)** sử dụng số nguyên `micro-USD` và sổ cái bất biến `model_call_ledgers`.
  5. **Stages 1–4 Product Pipeline Engine:** Stage 1 (Fact/Assumption/Recommendation — `AC-10`), Stage 2 (PRD/SRS), Stage 3 (Architecture/ERD/API Spec/Security Design/ADRs), Stage 4 (`Cross-Artifact Consistency Checker`, `Project Approval Gates` & immutable `Baseline Spec Freeze`).
  6. **PostgreSQL Additive Migration `0006`** với `FORCE ROW LEVEL SECURITY` và ràng buộc quan hệ/trigger cấp DB.

---

## 1. Model Provider Adapter v2, Prompt Versioning & Structured Output

### 1.1. Config-Driven Multi-Provider Swapping (`AC-01`)
Hệ thống hỗ trợ 3 provider qua `LiveModelProviderClient` (`anthropic`, `openai`, `google`):
- Cấu hình được tải qua `ModelProviderConfig` hoặc biến môi trường (`SF_MODEL_PROVIDER`, `SF_MODEL_NAME`, `SF_MODEL_BASE_URL`, `SF_MODEL_API_KEY`, `SF_MODEL_ALLOWED_HOSTS`, `SF_MODEL_TIMEOUT_MS`).
- Mọi Stage trong Stages 1–4 và tầng thực thi gọi qua giao diện thống nhất `ManagedModelProviderExecutor` — cho phép đổi provider (ví dụ từ `anthropic` sang `openai` hoặc `google`) **100% qua cấu hình** mà không sửa bất kỳ dòng code nghiệp vụ nào của Pipeline hay Workflow Engine.
- Kế thừa nguyên tắc `Fail-Closed`: thiếu API key -> `ModelProviderConfigurationError`; non-loopback `http://` baseUrl -> từ chối trừ khi bật tường minh cờ kiểm thử.

### 1.2. Prompt Versioning (`PromptRegistry`)
Mỗi prompt dùng trong hệ thống phải được đăng ký dưới dạng phiên bản bất biến `(promptId, version)`:
- Cấu trúc `PromptTemplateSpec`: `{ promptId, version, description, systemTemplate, userTemplate, outputSchema?, requiredVariables? }`.
- Hàm băm chuẩn hóa:
  $$\text{prompt\_sha256} = \text{SHA256}(\text{canonicalizeJson}(\{\text{promptId}, \text{version}, \text{systemTemplate}, \text{userTemplate}, \text{outputSchema}\}))$$
- Cấm ghi đè `(promptId, version)` đã tồn tại bằng nội dung khác hash (`ConflictError`).
- Mọi bản ghi trong `model_call_ledgers` và `stage_artifacts` đều lưu đủ `(prompt_id, prompt_version, prompt_sha256)` để truy vết tái lập 100%.

### 1.3. Strict Structured Output Validation (`Fail-Closed`)
- Mọi lời gọi structured generation đều gắn `StructuredJsonSchema` (hỗ trợ `object`, `array`, `string`, `number`, `integer`, `boolean`, `null`, `required`, `additionalProperties`, `enum`, `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `items`, `minItems`, `maxItems`).
- Trình phân tích `extractJsonFromModelText` chỉ chấp nhận JSON thuần hoặc duy nhất 1 khối code fence ```` ```json ... ``` ````; mọi output thừa text mơ hồ, sai kiểu, thiếu trường `required`, vi phạm `enum` hoặc chứa field lạ khi `additionalProperties: false` đều ném `StructuredOutputValidationError` (`ERR_STRUCTURED_OUTPUT_INVALID`) và **ghi ledger trạng thái `FAILED_VALIDATION`** — tuyệt đối không tự sửa hay nuốt lỗi.

---

## 2. Per-Request & Session Token/Cost Guard (`AC-12b`)

### 2.1. Đơn vị Tiền tệ Nguyên (`micro-USD`)
- Để loại bỏ sai số dấu phẩy động IEEE-754 khi cộng dồn chi phí, toàn bộ chi phí được tính và lưu bằng số nguyên **`micro-USD`**:
  $$1\text{ USD} = 1{,}000{,}000\text{ micro-USD}$$
- Công thức chi phí mỗi call theo bảng giá `ModelPricingRate { inputMicroUsdPerMillionTokens, outputMicroUsdPerMillionTokens }`:
  $$\text{cost\_micro\_usd} = \left\lceil \frac{\text{input\_tokens} \cdot R_{\text{in}} + \text{output\_tokens} \cdot R_{\text{out}}}{1{,}000{,}000} \right\rceil$$

### 2.2. Hai Lớp Bảo vệ Pre-Flight & Post-Call (`AC-12b`)
Mỗi phiên gọi LLM gắn với một `model_cost_sessions`:
- **Ngưỡng Per-Request:** `max_tokens_per_request`, `max_cost_micro_usd_per_request`.
- **Ngưỡng Session Tích lũy:** `session_token_budget`, `session_cost_budget_micro_usd`.

Quy trình cưỡng chế cho từng request:
1. **Pre-Flight Check (Trước khi mở kết nối HTTP tới Model Provider):**
   - Ước lượng `estimated_input_tokens` từ `systemPrompt` + `userPrompt` và cộng dự phòng `reserved_output_tokens = req.maxTokens ?? defaultMaxTokens`.
   - Kiểm tra dưới khóa hàng `FOR UPDATE` trên `model_cost_sessions`:
     - `projected_tokens <= max_tokens_per_request`
     - `projected_cost_micro_usd <= max_cost_micro_usd_per_request`
     - `tokens_used_total + projected_tokens <= session_token_budget`
     - `cost_used_micro_usd + projected_cost_micro_usd <= session_cost_budget_micro_usd`
   - **Nếu vượt bất kỳ ngưỡng nào:** Ghi nhận **độc lập và bền vững (`COMMIT`)** một dòng vào sổ cái append-only `model_call_ledgers` với `status = 'BLOCKED_PREFLIGHT'` và `block_reason`, KHÔNG gửi HTTP request tới Provider, sau đó ném `CostBudgetExceededError` (`ERR_COST_LIMIT_EXCEEDED` / `ERR_SESSION_BUDGET_EXCEEDED`).
2. **Post-Call Accounting (Sau khi Provider phản hồi):**
   - Chuẩn hóa token sử dụng thực tế từ 3 Provider (`Anthropic usage`, `OpenAI usage`, `Gemini usageMetadata`), tính chi phí thực tế `actual_cost_micro_usd`.
   - Cộng dồn nguyên tử vào `model_cost_sessions.tokens_used_total` và `cost_used_micro_usd`.
   - Nếu bản ghi thực tế sau khi cộng dồn vượt quá giới hạn phiên hoặc giới hạn per-request thực tế: chuyển `model_cost_sessions.status = 'EXHAUSTED'`, ghi ledger `status = 'BLOCKED_POSTCALL'`, commit sổ cái để không mất dấu chi phí đã phát sinh, và ném `CostBudgetExceededError`.
   - Nếu hợp lệ (hoặc đạt đúng trần `== budget`): giữ `ALLOWED` (tự động chuyển `EXHAUSTED` nếu không còn dư địa nếu cần hoặc ở call kế tiếp) và trả kết quả.

---

## 3. Product Pipeline Stages 1–4 & Invariants (`AC-10`, Consistency Check, Spec Freeze)

### 3.1. Stage 1 — Idea & Discovery Clarification (`AC-10`)
Đầu vào là mô tả ý tưởng tự nhiên (`raw_idea_text`). Hệ thống phân rã kết quả thành 3 loại bản ghi rõ ràng trong `stage1_discovery_items`:
1. **`FACT`**: Sự thật khách quan đã nêu trong ý tưởng / tài liệu nguồn -> `confirmation_status = 'AUTO_VERIFIED'` (hoặc `'CONFIRMED'`).
2. **`ASSUMPTION`**: Giả định chưa được xác chứng, bắt buộc kèm `clarification_question` -> khởi tạo **bắt buộc** với `confirmation_status = 'UNCONFIRMED'` (cả DB `CHECK` constraint `chk_s1_assumption_not_auto_verified` và lớp domain đều cấm `ASSUMPTION` mang trạng thái `AUTO_VERIFIED`).
3. **`RECOMMENDATION`**: Đề xuất kỹ thuật/sản phẩm -> khởi tạo với `confirmation_status = 'UNCONFIRMED'`, chỉ có giá trị ràng buộc khi được người dùng xác nhận (`CONFIRMED`).

Quy tắc chuyển trạng thái xác nhận (`resolveDiscoveryItem`):
- Người dùng xác nhận (`CONFIRM`) -> `confirmation_status = 'CONFIRMED'`, ghi rõ `confirmed_by_principal_id` & `confirmed_at`.
- Người dùng bác bỏ (`REJECT`) -> `confirmation_status = 'REJECTED'`, ghi rõ actor & timestamp.

### 3.2. Stage 2 — Requirements & Scope Specification (`PRD` & `SRS`) & Quy tắc `AC-10`
- Sinh cấu trúc gồm:
  - `prd`: `{ product_vision, target_personas, goals, non_goals }`
  - `srs`: `{ functional_requirements: Stage2RequirementItem[], non_functional_requirements: Stage2RequirementItem[] }`
- Mỗi `Stage2RequirementItem` bắt buộc gồm `req_id`, `title`, `description`, `priority`, `source_discovery_item_ids` (**ít nhất 1 ID**), và `acceptance_criteria` (`ac_id`, `given`, `when`, `then`).
- **Cưỡng chế Cứng `AC-10` tại 3 tầng (Model Prompt/Filter, Domain Validation, PostgreSQL Trigger):**
  - Bất kỳ `source_discovery_item_ids` nào trỏ tới một `Stage 1` item chưa xác nhận (`UNCONFIRMED`) hoặc đã bác bỏ (`REJECTED`) — đặc biệt là `ASSUMPTION` chưa xác nhận — đều bị **từ chối Fail-Closed** (`ERR_AC10_UNCONFIRMED_ASSUMPTION` / `SQLSTATE 23514`).

### 3.3. Stage 3 — Technology & Architecture Design
Từ Stage 2 `PRD` & `SRS` đã hợp lệ, sinh gói kiến trúc 5 phần gắn mã yêu cầu `requirement_ids[]`:
1. `architecture.components`: Danh sách thành phần và trách nhiệm.
2. `database_erd.entities`: Các thực thể/bảng dữ liệu, khóa chính, khóa ngoại và phân tầng RLS.
3. `api_spec.endpoints`: Hợp đồng API, phương thức HTTP, đường dẫn, phân quyền RBAC.
4. `security_design.threat_controls`: Mối đe dọa và cơ chế phòng vệ tương ứng.
5. `adrs`: Các Architecture Decision Records (`ADR-*`) kèm bối cảnh, quyết định, hệ quả.

### 3.4. Stage 4 — Cross-Artifact Validation, Project Approval Gates & Immutable Baseline Spec Freeze
1. **`CrossArtifactConsistencyChecker`:**
   - `CHK-01` (`AC-10`): Không có yêu cầu Stage 2 nào dẫn chiếu tới Stage 1 `ASSUMPTION` chưa xác nhận hoặc item `UNCONFIRMED`/`REJECTED`.
   - `CHK-02` (Stage 1 $\rightarrow$ Stage 2 Coverage): Mọi Stage 1 `FACT` (`AUTO_VERIFIED`) và `ASSUMPTION` đã `CONFIRMED` đều được ánh xạ vào $\ge 1$ Requirement Stage 2; mọi Requirement đều có $\ge 1$ `Acceptance Criterion`.
   - `CHK-03` (Stage 2 $\leftrightarrow$ Stage 3 Bidirectional Integrity): Mọi `req_id` trong Stage 2 được bao phủ bởi $\ge 1$ Component và $\ge 1$ thiết kế kỹ thuật (ERD / API / Security / ADR) trong Stage 3; không có `requirement_ids` mồ côi trỏ tới `req_id` không tồn tại.
   - `CHK-04` (Stage 3 Completeness): Đầy đủ cả 5 mảng (`components`, `entities`, `endpoints`, `threat_controls`, `adrs`).
   - `CHK-05` (Cryptographic Hash Verification): Hash canonical JSON của từng artifact Stages 1–3 trùng khớp với `artifact_sha256` đã lưu.
2. **Project Approval Gates (`stage_approval_gates`):**
   - Chỉ principal có quyền **`PROJECT_APPROVER`** hoặc **`ORG_ADMIN`** (đối chiếu qua HMAC Token + `project_memberships` RLS) mới được phê duyệt gate `STAGE_4_SPEC_FREEZE` (hoặc các gate từng stage).
3. **Immutable Baseline Spec Freeze (`baseline_spec_freezes`):**
   - Chỉ thực thi khi:
     - Report Stage 4 mới nhất có `passed === true`,
     - Có `stage_approval_gates` trạng thái `APPROVED` cho `gate_stage = 'STAGE_4_SPEC_FREEZE'` khóa đúng `(validation_report_artifact_id, validation_report_sha256)`,
     - Chưa có bản ghi `FROZEN` cho phiên đó.
   - Lưu bản ghi bất biến gồm cả 4 cặp `(artifact_id, sha256)` cùng `freeze_bundle_sha256` và chuyển `product_pipeline_sessions.status = 'FROZEN'`.
   - Một khi đã `FROZEN`, PostgreSQL trigger & Control Plane khóa cứng: cấm mọi chỉnh sửa/thêm item Stage 1 hoặc artifact mới trong cùng session đó.

---

## 4. Schema PostgreSQL 4-Tier RLS (`0006`) & Tiêu chí Nghiệm thu `M6A-AC1 .. M6A-AC7`

### 4.1. Bảng mới trong Migration `0006`
Tất cả 7 bảng mới đều bật `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + `REVOKE ALL FROM PUBLIC`:
- `model_cost_sessions` (`UPDATE` giới hạn cấp cột: `tokens_used_total, cost_used_micro_usd, status, updated_at`; cấm `DELETE`).
- `model_call_ledgers` (**append-only:** `SELECT, INSERT` duy nhất).
- `product_pipeline_sessions` (`UPDATE` giới hạn cấp cột: `cost_session_id, current_stage, status, frozen_baseline_id, updated_at`; cấm `DELETE`).
- `stage1_discovery_items` (`UPDATE` giới hạn cấp cột xác nhận Q&A; cấm `DELETE`; `CHECK` cấm `ASSUMPTION` mang `AUTO_VERIFIED`).
- `stage_artifacts` (**append-only:** `SELECT, INSERT`; trigger cưỡng chế `AC-10` và khóa sau `FROZEN`).
- `stage_approval_gates` (**append-only:** `SELECT, INSERT`).
- `baseline_spec_freezes` (**append-only:** `SELECT, INSERT`; khóa ngoại kép composite tới cả 4 artifact + gate `APPROVED`; `uq_one_frozen_baseline_per_session`).

### 4.2. Bảng Tiêu chí Nghiệm thu Nhị phân `M6A`

| Mã TC | Mô tả Kiểm chứng | Điều kiện PASS |
| :--- | :--- | :--- |
| **`M6A-AC1`** | Config-Driven Multi-Provider Swap (`>= 2` Providers) | Hoán đổi qua lại giữa ít nhất 2 providers (`anthropic`, `openai`, `google`) hoàn toàn bằng cấu hình trên cùng Prompt & Pipeline mà không sửa code nghiệp vụ. |
| **`M6A-AC2`** | Prompt Versioning & Structured Output Validation | Tải/render đúng `(promptId, version, promptSha256)`, chặn ghi đè phiên bản; từ chối Fail-Closed JSON sai schema và ghi `FAILED_VALIDATION` vào ledger. |
| **`M6A-AC3`** | Per-Request & Session Token/Cost Guard (`AC-12b`) | Chặn `BLOCKED_PREFLIGHT` trước khi gọi HTTP nếu request vượt ngưỡng token/chi phí hoặc làm cạn ngân sách phiên; ghi ledger cả call hợp lệ lẫn call bị chặn trong PostgreSQL & In-Memory. |
| **`M6A-AC4`** | Stage 1 Distinction & `AC-10` Non-Promotion Guard | Stage 1 bóc tách đúng `FACT`, `ASSUMPTION` (`UNCONFIRMED`), `RECOMMENDATION`; chặn cứng nếu Stage 2 tham chiếu `ASSUMPTION` chưa xác nhận (tại cả tầng Model/Domain lẫn SQL Trigger `23514`); thông qua sau khi người dùng `CONFIRM`. |
| **`M6A-AC5`** | Stages 1 $\rightarrow$ 4 Sample Project E2E & Spec Freeze | Một dự án mẫu đi trọn từ `raw_idea_text` qua Stage 1 $\rightarrow$ Confirm/Reject Q&A $\rightarrow$ Stage 2 (`PRD`/`SRS`) $\rightarrow$ Stage 3 (`Architecture`/`ERD`/`API`/`Security`/`ADRs`) $\rightarrow$ Stage 4 `CrossArtifactConsistencyChecker` `PASS` $\rightarrow$ Project Approval Gate (`PROJECT_APPROVER`) $\rightarrow$ `BaselineSpecFreeze` (`FROZEN`) trên cả HTTP API + Web UI. |
| **`M6A-AC6`** | Cross-Artifact Consistency Checker Rejection & Freeze Immutability | Checker bắt được lỗi thiếu traceability / dangling requirement ID / hash mismatch và **cấm freeze**; sau khi `FROZEN`, mọi thao tác sửa Stage 1 hoặc ghi đè artifact cùng session bị từ chối Fail-Closed; `DEVELOPER` bị chặn `403` khi gọi Approval Gate / Freeze. |
| **`M6A-AC7`** | PostgreSQL 16 `0006` Hardened RLS, Append-Only & Column Grants | Xác minh đầy đủ trên PostgreSQL 16 thật: cross-tenant `42501` / `0 rows`, `app_runtime` bị từ chối `UPDATE`/`DELETE` trên bảng append-only, từ chối update cột không whitelist, `DISCARD ALL`, upgrade `86076639 -> HEAD` sạch sẽ. |
