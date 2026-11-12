-- Independent denial intents deliberately have no parent FK: the owning TX may
-- have inserted those parents and may roll back or die before completion work.
CREATE TABLE IF NOT EXISTS budget_denial_intents (
  intent_id UUID PRIMARY KEY,
  project_id UUID NOT NULL,
  outer_xid XID8 NOT NULL,
  payload_json JSONB NOT NULL CHECK(jsonb_typeof(payload_json)='object'),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','COMPLETED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ NULL
);
ALTER TABLE budget_denial_intents OWNER TO db_migrator;
ALTER TABLE budget_denial_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_denial_intents FORCE ROW LEVEL SECURITY;
REVOKE ALL ON budget_denial_intents FROM PUBLIC, app_runtime;
GRANT SELECT, INSERT ON budget_denial_intents TO app_runtime;
GRANT UPDATE(status, completed_at) ON budget_denial_intents TO app_runtime;
DROP POLICY IF EXISTS budget_denial_intents_scope ON budget_denial_intents;
CREATE POLICY budget_denial_intents_scope ON budget_denial_intents
  USING(project_id=current_app_project_id() AND current_app_role() IN ('core_api_service','gateway_service'))
  WITH CHECK(project_id=current_app_project_id() AND current_app_role() IN ('core_api_service','gateway_service'));
CREATE INDEX IF NOT EXISTS idx_budget_denial_pending ON budget_denial_intents(project_id,created_at,intent_id) WHERE status='PENDING';
CREATE OR REPLACE FUNCTION fn_budget_denial_intent_transition() RETURNS trigger AS $$
BEGIN
  IF NEW.intent_id IS DISTINCT FROM OLD.intent_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.outer_xid IS DISTINCT FROM OLD.outer_xid OR NEW.payload_json IS DISTINCT FROM OLD.payload_json
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.status <> 'PENDING' OR NEW.status <> 'COMPLETED'
    OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'Budget denial intent is immutable except for completion' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
DROP TRIGGER IF EXISTS trg_budget_denial_intent_transition ON budget_denial_intents;
CREATE TRIGGER trg_budget_denial_intent_transition BEFORE UPDATE ON budget_denial_intents
FOR EACH ROW EXECUTE FUNCTION fn_budget_denial_intent_transition();
