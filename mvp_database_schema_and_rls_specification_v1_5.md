# Software Factory — Đặc tả Cơ sở Dữ liệu, Giao thức Khóa & Ma trận RLS (`MVP_DATABASE_AND_RLS_SPEC.md`)

- **Mã tài liệu:** `MVP-SPEC-02` ([`MVP_DATABASE_AND_RLS_SPEC.md`](./mvp_database_schema_and_rls_specification_v1_5.md))
- **Phiên bản:** 1.5
- **Ngày cập nhật:** 2026-11-09
- **Trạng thái:** Ready for Milestone `M1` Implementation (`M0` Gate Locked)
- **Bộ tài liệu Core Specs `M0.2`:** [MVP-SPEC-01](./mvp_scope_and_architecture_specification_v1_5.md) · [MVP-SPEC-02](./mvp_database_schema_and_rls_specification_v1_5.md) · [MVP-SPEC-03](./mvp_lease_event_protocol_sandbox_and_git_import_specification_v1_5.md) · [MVP-SPEC-04](./mvp_verifier_3d_reviewer_approval_and_recovery_specification_v1_5.md)
- **Phạm vi:** Định nghĩa kiến trúc phân quyền PostgreSQL (`db_migrator` vs. `app_runtime`), lược đồ DDL cốt lõi của MVP trên 4 tầng sở hữu dữ liệu, chính sách `FORCE ROW LEVEL SECURITY`, giao thức khóa chuẩn `FOR UPDATE` với `clock_timestamp()` và **Ma trận 8 Kịch bản Kiểm thử Đọc/Ghi RLS (`RLS-T1` $\rightarrow$ `RLS-T8`)**.

---

## 1. Phân tách Database Roles & 5 Điều kiện Cưỡng chế Hạ tầng RLS (`P-002`, `P-009`, `P1-6`)

Để đảm bảo không một truy vấn nào từ ứng dụng có thể vượt rào RLS (kể cả khi có lỗi lập trình thiếu mệnh đề `WHERE` trong câu lệnh SQL), tầng PostgreSQL bắt buộc cấu hình theo 5 quy tắc cứng sau đây:

### 1.1. Khởi tạo Tách biệt `db_migrator` (Table Owner) và `app_runtime` (Application Role)

```sql
-- 1. Role chỉ dùng khi chạy Migration tạo/sửa bảng (Sở hữu toàn bộ các bảng)
CREATE ROLE db_migrator WITH
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOBYPASSRLS
  PASSWORD 'REDACTED_MIGRATOR_SECRET';

-- 2. Role duy nhất mà core-api và agent-gateway được phép dùng khi vận hành
CREATE ROLE app_runtime WITH
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOBYPASSRLS
  PASSWORD 'REDACTED_RUNTIME_SECRET';

-- 3. Role quản trị danh mục hệ thống (Chỉ dùng cho CLI quản trị Global Catalog Tier 1)
CREATE ROLE system_admin_role WITH
  NOLOGIN
  NOSUPERUSER
  NOBYPASSRLS;
```

### 1.2. Năm Quy tắc Cưỡng chế Kết nối & Transaction Pool
1. **Không phải Table Owner:** Toàn bộ bảng dữ liệu đều do `db_migrator` tạo và sở hữu (`OWNER TO db_migrator`). Dịch vụ chạy bằng `app_runtime` chỉ được cấp quyền `SELECT, INSERT, UPDATE, DELETE` trên từng bảng.
2. **Bật `FORCE ROW LEVEL SECURITY`:** Bắt buộc kích hoạt cả `ENABLE ROW LEVEL SECURITY` và `FORCE ROW LEVEL SECURITY` trên 100% bảng thuộc Tầng 2, Tầng 3A, Tầng 3B và Tầng 4.
3. **Thiết lập Ngữ cảnh bằng `SET LOCAL`:** Middleware cơ sở dữ liệu của `core-api` bắt buộc mở transaction `BEGIN;` và chạy hai lệnh `SET LOCAL` với thông tin trích xuất từ phiên xác thực trước mọi truy vấn nghiệp vụ:
   ```sql
   BEGIN;
   SELECT set_config('app.current_org_id', $1::text, true);
   SELECT set_config('app.current_project_id', $2::text, true);
   ```
4. **Fail-Closed Mặc định khi Thiếu Ngữ cảnh:** Mọi biểu thức RLS đều sử dụng hàm đọc an toàn `NULLIF(current_setting('app.current_project_id', true), '')::uuid`. Nếu ứng dụng quên gọi `SET LOCAL`, biểu thức trả về `NULL`, phép so sánh `= NULL` trả về `UNKNOWN` (falsy) và PostgreSQL tự động chặn `0 rows`.
5. **Làm sạch Connection Pool:** Khi trả kết nối từ ứng dụng về Connection Pool, driver bắt buộc thực thi `DISCARD ALL;` (hoặc `RESET ALL;`) để xóa sạch mọi trạng thái phiên.

---

## 2. Lược đồ DDL Cốt lõi của MVP theo 4 Tầng Sở hữu Dữ liệu

Toàn bộ câu lệnh DDL dưới đây được thực thi dưới quyền `db_migrator`:

```sql
SET ROLE db_migrator;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- TẦNG 1: GLOBAL / SYSTEM-OWNED TABLES (Không có org_id / project_id)
-- ============================================================================
CREATE TABLE runtime_adapters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    adapter_key VARCHAR(64) NOT NULL UNIQUE, -- VD: 'claude-code-cli', 'codex-cli', 'fake-agent'
    display_name VARCHAR(128) NOT NULL,
    version VARCHAR(32) NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- ============================================================================
-- TẦNG 2: ORGANIZATION-OWNED TABLES
-- ============================================================================
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    role VARCHAR(32) NOT NULL CHECK (role IN ('ORG_ADMIN', 'PROJECT_APPROVER', 'DEVELOPER', 'AUDITOR')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (organization_id, email),
    UNIQUE (organization_id, id)
);

CREATE TABLE worker_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    node_name VARCHAR(128) NOT NULL,
    target_tier VARCHAR(32) NOT NULL DEFAULT 'factory_managed_worker'
        CHECK (target_tier IN ('factory_managed_worker')), -- MVP khóa cứng Tier 1
    principal_id VARCHAR(128) NOT NULL UNIQUE,
    credential_fingerprint VARCHAR(128) NOT NULL,
    status VARCHAR(32) NOT NULL CHECK (status IN ('ONLINE', 'OFFLINE', 'DRAINING', 'REVOKED')),
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- ============================================================================
-- TẦNG 3A: PROJECT ROOT TABLE
-- ============================================================================
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    slug VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    default_branch VARCHAR(64) NOT NULL DEFAULT 'main',
    approval_ttl_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (approval_ttl_seconds > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (organization_id, slug),
    UNIQUE (id, organization_id)
);

-- ============================================================================
-- TẦNG 3B: PROJECT-OWNED CHILD TABLES (Có cột project_id)
-- ============================================================================
CREATE TABLE tasks (
    task_id UUID NOT NULL DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    status VARCHAR(40) NOT NULL CHECK (status IN (
        'Ready',
        'Leased',
        'ExecutingInTarget',
        'BuildingMergeCandidate',
        'VerifyingInDocker',
        'UnderIndependentReview',
        'AwaitingHumanApproval',
        'AtomicCasMerge',
        'MergedAndCompleted',
        'ReworkRequired',
        'ManualIntervention'
    )),
    base_main_commit_hash CHAR(40) NOT NULL,
    current_lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (current_lease_epoch >= 0),
    rework_count INTEGER NOT NULL DEFAULT 0 CHECK (rework_count >= 0),
    max_rework_cycles INTEGER NOT NULL DEFAULT 3 CHECK (max_rework_cycles >= 1),
    current_candidate_hash CHAR(40),
    merged_commit_hash CHAR(40),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (project_id, task_id)
);

CREATE TABLE task_contracts (
    project_id UUID NOT NULL,
    task_id UUID NOT NULL,
    allowed_files JSONB NOT NULL DEFAULT '[]'::jsonb,
    protected_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
    forbidden_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
    max_changed_files INTEGER NOT NULL DEFAULT 25 CHECK (max_changed_files > 0),
    max_deleted_lines INTEGER NOT NULL DEFAULT 500 CHECK (max_deleted_lines >= 0),
    max_binary_bytes INTEGER NOT NULL DEFAULT 1048576 CHECK (max_binary_bytes >= 0),
    acceptance_criteria_md TEXT NOT NULL,
    trusted_policy_sha256 CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (project_id, task_id),
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, task_id) ON DELETE CASCADE
);

-- ============================================================================
-- TẦNG 4: EXECUTION-OWNED TABLES (Khóa ngoại kép (project_id, task_id))
-- ============================================================================
CREATE TABLE task_leases (
    project_id UUID NOT NULL,
    task_id UUID NOT NULL,
    lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 1),
    worker_id UUID NOT NULL REFERENCES worker_nodes(id),
    developer_principal_id VARCHAR(128) NOT NULL,
    session_id UUID NOT NULL,
    status VARCHAR(24) NOT NULL CHECK (status IN ('ACTIVE', 'COMPLETED', 'EXPIRED', 'REVOKED')),
    last_processed_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_processed_seq >= 0),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    revoke_reason VARCHAR(255),
    PRIMARY KEY (project_id, task_id, lease_epoch),
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, task_id) ON DELETE CASCADE
);

-- Đảm bảo tại mọi thời điểm mỗi Task chỉ có tối đa 1 Lease đang ACTIVE
CREATE UNIQUE INDEX idx_task_leases_single_active
    ON task_leases (project_id, task_id)
    WHERE status = 'ACTIVE';

CREATE TABLE processed_events (
    event_id UUID NOT NULL DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    task_id UUID NOT NULL,
    lease_epoch INTEGER NOT NULL,
    sequence_no INTEGER NOT NULL CHECK (sequence_no >= 1),
    event_idempotency_key VARCHAR(255) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload_sha256 CHAR(64) NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (project_id, event_id),
    UNIQUE (project_id, event_idempotency_key),
    UNIQUE (project_id, task_id, lease_epoch, sequence_no),
    FOREIGN KEY (project_id, task_id, lease_epoch)
        REFERENCES task_leases(project_id, task_id, lease_epoch) ON DELETE CASCADE
);

CREATE TABLE outbox_events (
    outbox_id BIGSERIAL,
    project_id UUID NOT NULL,
    task_id UUID NOT NULL,
    lease_epoch INTEGER NOT NULL,
    sequence_no INTEGER NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (project_id, outbox_id),
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, task_id) ON DELETE CASCADE
);

CREATE TABLE verified_code_imports (
    import_id UUID NOT NULL DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    task_id UUID NOT NULL,
    lease_epoch INTEGER NOT NULL,
    isolated_git_ref VARCHAR(255) NOT NULL,
    base_main_commit_hash CHAR(40) NOT NULL,
    agent_commit_hash CHAR(40) NOT NULL,
    changed_files_count INTEGER NOT NULL,
    deleted_lines_count INTEGER NOT NULL,
    recovered_by_reconciler BOOLEAN NOT NULL DEFAULT false,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (project_id, import_id),
    UNIQUE (project_id, task_id, lease_epoch, agent_commit_hash),
    FOREIGN KEY (project_id, task_id, lease_epoch)
        REFERENCES task_leases(project_id, task_id, lease_epoch) ON DELETE CASCADE
);

CREATE TABLE merge_candidates (
    candidate_id UUID NOT NULL DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    task_id UUID NOT NULL,
    lease_epoch INTEGER NOT NULL,
    agent_commit_hash CHAR(40) NOT NULL,
    base_main_commit_hash CHAR(40) NOT NULL,
    merge_candidate_hash CHAR(40) NOT NULL,
    verified_tree_hash CHAR(40) NOT NULL,
    snapshot_uri TEXT NOT NULL,
    snapshot_sha256 CHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL CHECK (status IN ('ACTIVE', 'INVALIDATED_STALE_BASE', 'SUPERSEDED', 'MERGED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (project_id, candidate_id),
    UNIQUE (project_id, task_id, merge_candidate_hash),
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, task_id) ON DELETE CASCADE
);

CREATE TABLE verification_runs (
    verification_run_id UUID NOT NULL DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    task_id UUID NOT NULL,
    candidate_id UUID NOT NULL,
    merge_candidate_hash CHAR(40) NOT NULL,
    verified_tree_hash CHAR(40) NOT NULL,
    tier1_trusted_acceptance_passed BOOLEAN NOT NULL,
    tier2_protected_baseline_passed BOOLEAN NOT NULL,
    tier2_baseline_tamper_detected BOOLEAN NOT NULL DEFAULT false,
    tier3_agent_tests_passed BOOLEAN NOT NULL,
    overall_status VARCHAR(32) NOT NULL CHECK (overall_status IN (
        'PASSED', 'FAILED_ACCEPTANCE', 'TEST_TAMPERING_DETECTED', 'FAILED_AGENT_TESTS', 'TEST_TIMEOUT', 'INFRA_ERROR'
    )),
    infra_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (infra_retry_count BETWEEN 0 AND 2),
    report_uri TEXT NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (project_id, verification_run_id),
    FOREIGN KEY (project_id, candidate_id) REFERENCES merge_candidates(project_id, candidate_id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, task_id) ON DELETE CASCADE
);

CREATE TABLE review_artifacts (
    review_artifact_id UUID NOT NULL DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    task_id UUID NOT NULL,
    candidate_id UUID NOT NULL,
    verification_run_id UUID NOT NULL,
    merge_candidate_hash CHAR(40) NOT NULL,
    verified_tree_hash CHAR(40) NOT NULL,
    developer_principal_id VARCHAR(128) NOT NULL,
    reviewer_principal_id VARCHAR(128) NOT NULL,
    reviewer_session_id UUID NOT NULL,
    verdict VARCHAR(16) NOT NULL CHECK (verdict IN ('APPROVE', 'REJECT')),
    status VARCHAR(32) NOT NULL DEFAULT 'VALID'
        CHECK (status IN ('VALID', 'INVALIDATED_STALE_CANDIDATE', 'INVALIDATED_STALE_BASE')),
    findings_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (project_id, review_artifact_id),
    -- Cưỡng chế Identity Independence ở tầng Database (P1-7)
    CONSTRAINT chk_3d_reviewer_distinct_principal
        CHECK (reviewer_principal_id <> developer_principal_id),
    FOREIGN KEY (project_id, verification_run_id)
        REFERENCES verification_runs(project_id, verification_run_id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, task_id) ON DELETE CASCADE
);

CREATE TABLE approval_requests (
    approval_request_id UUID NOT NULL DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    task_id UUID NOT NULL,
    candidate_id UUID NOT NULL,
    merge_candidate_hash CHAR(40) NOT NULL,
    verified_tree_hash CHAR(40) NOT NULL,
    verification_run_id UUID NOT NULL,
    review_artifact_id UUID NOT NULL,
    status VARCHAR(32) NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'INVALIDATED_EXPIRED', 'INVALIDATED_STALE_BASE')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (project_id, approval_request_id),
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, task_id) ON DELETE CASCADE
);

CREATE TABLE approval_decisions (
    approval_decision_id UUID NOT NULL DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    task_id UUID NOT NULL,
    approval_request_id UUID NOT NULL,
    approver_user_id UUID NOT NULL,
    -- Bộ 8 trường khóa cứng vào C_candidate (P1-7)
    agent_commit_hash CHAR(40) NOT NULL,
    base_main_commit_hash CHAR(40) NOT NULL,
    merge_candidate_hash CHAR(40) NOT NULL,
    verified_tree_hash CHAR(40) NOT NULL,
    verification_run_id UUID NOT NULL,
    review_artifact_id UUID NOT NULL,
    decision VARCHAR(24) NOT NULL CHECK (decision IN ('APPROVE', 'REQUEST_CHANGES')),
    status VARCHAR(32) NOT NULL DEFAULT 'VALID'
        CHECK (status IN ('VALID', 'INVALIDATED_STALE_BASE', 'CONSUMED_BY_MERGE')),
    decided_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (project_id, approval_decision_id),
    UNIQUE (project_id, task_id, merge_candidate_hash),
    FOREIGN KEY (project_id, approval_request_id)
        REFERENCES approval_requests(project_id, approval_request_id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, task_id) ON DELETE CASCADE
);

CREATE TABLE merge_operations (
    merge_op_id UUID NOT NULL DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    task_id UUID NOT NULL,
    approval_decision_id UUID NOT NULL,
    merge_idempotency_key VARCHAR(255) NOT NULL,
    base_main_commit_hash CHAR(40) NOT NULL,
    merge_candidate_hash CHAR(40) NOT NULL,
    verified_tree_hash CHAR(40) NOT NULL,
    status VARCHAR(32) NOT NULL CHECK (status IN ('IN_PROGRESS', 'MERGED', 'CAS_CONFLICT_ABORTED')),
    reconciled_after_lost_response BOOLEAN NOT NULL DEFAULT false,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (project_id, merge_op_id),
    UNIQUE (project_id, merge_idempotency_key),
    FOREIGN KEY (project_id, approval_decision_id)
        REFERENCES approval_decisions(project_id, approval_decision_id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, task_id) ON DELETE CASCADE
);

CREATE TABLE resource_usage_metrics (
    metric_id UUID NOT NULL DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    task_id UUID NOT NULL,
    lease_epoch INTEGER NOT NULL,
    rework_cycle INTEGER NOT NULL,
    wall_time_ms BIGINT NOT NULL,
    cpu_usage_usec BIGINT NOT NULL,
    peak_memory_bytes BIGINT NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (project_id, metric_id),
    FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, task_id) ON DELETE CASCADE
);
```

---

## 3. Chính sách PostgreSQL RLS Chính xác trên Cả 4 Tầng (`P-009`, `P1-6`)

```sql
-- Hàm tiện ích đọc biến phiên an toàn (Fail-Closed trả về NULL nếu chưa gọi SET LOCAL)
CREATE OR REPLACE FUNCTION app_current_org_id() RETURNS UUID
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app_current_project_id() RETURNS UUID
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.current_project_id', true), '')::uuid;
$$;

-- Hàm chỉ mục an toàn cho LeaseExpiryReconciler: chỉ trả về bộ định danh (organization_id, project_id, task_id, lease_epoch)
-- của các Lease đang ACTIVE nhưng đã quá hạn để Reconciler mở giao dịch có đầy đủ SET LOCAL theo từng Project.
CREATE OR REPLACE FUNCTION list_expired_active_lease_scopes(batch_limit INTEGER DEFAULT 100)
RETURNS TABLE (
    organization_id UUID,
    project_id UUID,
    task_id UUID,
    lease_epoch INTEGER
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT p.organization_id, l.project_id, l.task_id, l.lease_epoch
    FROM task_leases l
    JOIN projects p ON p.id = l.project_id
    WHERE l.status = 'ACTIVE'
      AND l.expires_at <= clock_timestamp()
    ORDER BY l.expires_at ASC
    LIMIT batch_limit;
$$;

ALTER FUNCTION list_expired_active_lease_scopes(INTEGER) OWNER TO db_migrator;
REVOKE ALL ON FUNCTION list_expired_active_lease_scopes(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_expired_active_lease_scopes(INTEGER) TO app_runtime;

-- Cấp quyền truy cập bảng cho app_runtime
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT ON runtime_adapters TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON
    organizations, users, worker_nodes, projects,
    tasks, task_contracts, task_leases, processed_events, outbox_events,
    verified_code_imports, merge_candidates, verification_runs,
    review_artifacts, approval_requests, approval_decisions,
    merge_operations, resource_usage_metrics
TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;

-- ============================================================================
-- TẦNG 1: GLOBAL CATALOG RLS (app_runtime chỉ đọc được bản ghi is_enabled = true)
-- ============================================================================
ALTER TABLE runtime_adapters ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_adapters FORCE ROW LEVEL SECURITY;

CREATE POLICY rls_tier1_runtime_adapters_select ON runtime_adapters
    FOR SELECT TO app_runtime
    USING (is_enabled = true);

CREATE POLICY rls_tier1_runtime_adapters_admin_write ON runtime_adapters
    FOR ALL TO system_admin_role
    USING (true) WITH CHECK (true);

-- ============================================================================
-- TẦNG 2: ORGANIZATION-OWNED RLS
-- ============================================================================
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

CREATE POLICY rls_tier2_organizations_all ON organizations
    FOR ALL TO app_runtime
    USING (id = app_current_org_id())
    WITH CHECK (id = app_current_org_id());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY rls_tier2_users_all ON users
    FOR ALL TO app_runtime
    USING (organization_id = app_current_org_id())
    WITH CHECK (organization_id = app_current_org_id());

ALTER TABLE worker_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_nodes FORCE ROW LEVEL SECURITY;

CREATE POLICY rls_tier2_worker_nodes_all ON worker_nodes
    FOR ALL TO app_runtime
    USING (organization_id = app_current_org_id())
    WITH CHECK (organization_id = app_current_org_id());

-- ============================================================================
-- TẦNG 3A: PROJECT ROOT TABLE RLS (Khóa kép cả id VÀ organization_id)
-- ============================================================================
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

CREATE POLICY rls_tier3a_projects_all ON projects
    FOR ALL TO app_runtime
    USING (
        id = app_current_project_id()
        AND organization_id = app_current_org_id()
    )
    WITH CHECK (
        id = app_current_project_id()
        AND organization_id = app_current_org_id()
    );

-- ============================================================================
-- TẦNG 3B & TẦNG 4: PROJECT CHILD & EXECUTION TABLES RLS
-- ============================================================================
DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'tasks', 'task_contracts', 'task_leases', 'processed_events',
        'outbox_events', 'verified_code_imports', 'merge_candidates',
        'verification_runs', 'review_artifacts', 'approval_requests',
        'approval_decisions', 'merge_operations', 'resource_usage_metrics'
    ]
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', tbl);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', tbl);
        EXECUTE format('
            CREATE POLICY rls_project_isolation_%I ON %I
            FOR ALL TO app_runtime
            USING (project_id = app_current_project_id())
            WITH CHECK (project_id = app_current_project_id());
        ', tbl, tbl);
    END LOOP;
END $$;
```

---

## 4. Giao thức Khóa Độc quyền Chuẩn (`Canonical Lock`) & `clock_timestamp()` (`P-006`)

Để ngăn chặn hoàn toàn hiện tượng deadlock và race condition giữa luồng Worker gửi sự kiện (`Submit Event` / `Heartbeat`) với luồng Control Plane thu hồi Lease (`Revoke` / `Expire`), **100% giao dịch đụng chạm đến Lease và Task đều phải tuân theo thứ tự khóa sau**:

1. **Khi cấp Lease mới (`Grant Lease` — chưa có dòng `task_leases` của epoch mới):** Khóa dòng `tasks` bằng `SELECT ... FROM tasks WHERE project_id = $1 AND task_id = $2 FOR UPDATE`, kiểm tra không còn dòng `task_leases` nào đang `ACTIVE`, sau đó `INSERT INTO task_leases` với `lease_epoch = current_lease_epoch + 1`.
2. **Khi Lease đã tồn tại (`Submit Event`, `Heartbeat`, `Revoke Lease`, `Expire Lease`):** Luôn thực hiện phép `JOIN` và khóa **`task_leases` trước, `tasks` sau** bằng mệnh đề `FOR UPDATE OF l, t`:

```sql
-- Mẫu giao dịch Thu hồi Lease (Revoke Lease) thắng tuyệt đối mọi Event đến muộn
BEGIN;
SELECT set_config('app.current_org_id', $1::text, true);
SELECT set_config('app.current_project_id', $2::text, true);

SELECT l.lease_epoch, l.status AS lease_status, l.expires_at, t.status AS task_status
FROM task_leases l
JOIN tasks t
  ON t.project_id = l.project_id AND t.task_id = l.task_id
WHERE l.project_id = $2 AND l.task_id = $3 AND l.lease_epoch = $4
FOR UPDATE OF l, t;

-- Chỉ thu hồi nếu Lease vẫn đang ACTIVE
UPDATE task_leases
SET status = 'REVOKED',
    revoked_at = clock_timestamp(),
    revoke_reason = $5
WHERE project_id = $2 AND task_id = $3 AND lease_epoch = $4 AND status = 'ACTIVE';

-- Nếu chưa có code import hợp lệ, trả Task về Ready để cấp phát lại
UPDATE tasks
SET status = 'Ready',
    updated_at = clock_timestamp()
WHERE project_id = $2 AND task_id = $3 AND current_lease_epoch = $4
  AND NOT EXISTS (
      SELECT 1 FROM verified_code_imports v
      WHERE v.project_id = $2 AND v.task_id = $3 AND v.lease_epoch = $4
  );

COMMIT;
```

---

## 5. Đặc tả Ma trận 8 Kịch bản Kiểm thử Đọc/Ghi RLS (`RLS-T1` $\rightarrow$ `RLS-T8`) (`P1-6`)

Tại Milestone `M1`, bộ kiểm thử tự động trong `packages/test-harness` phải khởi tạo dữ liệu mẫu gồm 2 Tổ chức (`Org_A`, `Org_B`), 3 Dự án (`Proj_A1` và `Proj_A2` thuộc `Org_A`; `Proj_B1` thuộc `Org_B`), sau đó kết nối bằng tài khoản **`app_runtime`** và chạy 8 bài kiểm thử bắt buộc dưới đây:

| Mã Test | Thiết lập Phiên (`SET LOCAL`) | Câu lệnh SQL Thực thi Kiểm thử | Kết quả Kỳ vọng Bắt buộc (`PASS` Condition) |
| :--- | :--- | :--- | :--- |
| **`RLS-T1`** | **Không gọi `SET LOCAL`** (Ngữ cảnh rỗng) | 1. `SELECT count(*) FROM organizations;`<br>2. `SELECT count(*) FROM projects;`<br>3. `SELECT count(*) FROM tasks;`<br>4. `DELETE FROM task_leases;` | **Fail-Closed 100%:** Cả 3 câu lệnh `SELECT` đều trả về `0`; lệnh `DELETE` tác động `0 rows` (không một bản ghi nào bị xóa). |
| **`RLS-T2`** | `current_org_id = Org_A`<br>`current_project_id = Proj_A1` | Thực hiện `SELECT`, `INSERT`, `UPDATE`, `DELETE` trên `projects`, `tasks`, `task_leases`, `processed_events` với `project_id = Proj_A1`. | **Cho phép 100%:** Đọc đúng các bản ghi của `Proj_A1`; thêm mới, cập nhật và xóa thành công trong phạm vi `Proj_A1`. |
| **`RLS-T3`** | `current_org_id = Org_A`<br>`current_project_id = Proj_A1` | 1. `SELECT * FROM tasks WHERE project_id = 'Proj_A2';`<br>2. `UPDATE tasks SET title = 'Hacked' WHERE project_id = 'Proj_A2';`<br>3. `DELETE FROM review_artifacts WHERE project_id = 'Proj_A2';` | **Chặn Đọc/Ghi Chéo Project (`Cross-Project Isolation`):** `SELECT` trả về `0 rows`; `UPDATE` và `DELETE` tác động `0 rows`. |
| **`RLS-T4`** | `current_org_id = Org_A`<br>`current_project_id = Proj_A1` | `INSERT INTO tasks (project_id, task_id, title, status, base_main_commit_hash) VALUES ('Proj_A2', gen_random_uuid(), 'Inject', 'Ready', repeat('a', 40));` | **Chặn Ghi Chéo (`WITH CHECK` Violation):** PostgreSQL ném lỗi `SQLSTATE 42501: new row violates row-level security policy for table "tasks"`. |
| **`RLS-T5`** | `current_org_id = Org_A`<br>`current_project_id = Proj_A1` | `INSERT INTO task_leases (project_id, task_id, lease_epoch, ...) VALUES ('Proj_A1', '<task_id_của_Proj_A2>', 1, ...);` | **Chặn Gắn Chéo Cha-Con (`Composite FK Violation`):** PostgreSQL ném lỗi `SQLSTATE 23503: insert or update on table "task_leases" violates foreign key constraint`. |
| **`RLS-T6`** | `current_org_id = Org_A`<br>`current_project_id = Proj_B1` *(Project của `Org_B`)* | `SELECT * FROM projects WHERE id = 'Proj_B1';` | **Chặn Vượt Rào Tổ chức (`Cross-Org Isolation`):** Nhờ policy khóa kép `id = app_current_project_id() AND organization_id = app_current_org_id()` trên bảng `projects`, câu lệnh trả về `0 rows`. |
| **`RLS-T7`** | `current_org_id = Org_A`<br>`current_project_id = Proj_A1` (`ROLE app_runtime`) | 1. `SELECT * FROM runtime_adapters;`<br>2. `INSERT INTO runtime_adapters (...) VALUES (...);`<br>3. `UPDATE runtime_adapters SET is_enabled = false;` | **Bảo vệ Global Catalog (Tầng 1):** `SELECT` chỉ trả về các dòng có `is_enabled = true`; cả `INSERT` và `UPDATE` đều bị từ chối với lỗi `42501` (permission denied / RLS violation). |
| **`RLS-T8`** | Giao dịch 1 đặt `SET LOCAL` cho `Proj_A1` rồi `COMMIT` + `DISCARD ALL`. Giao dịch 2 lấy lại đúng kết nối đó nhưng không gọi `SET LOCAL`. | `SELECT count(*) FROM tasks;` (trong Giao dịch 2) | **Chống Rò rỉ Qua Connection Pool:** Kết quả trả về `0` (ngữ cảnh của Giao dịch 1 đã bị xóa sạch sau khi `COMMIT` và `DISCARD ALL`). |