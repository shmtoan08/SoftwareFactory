-- C2 review follow-up: consistent NULL validation and serialized event replay.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('telemetry.open_lifecycle_c2_legacy(uuid,uuid,uuid,uuid,text,text,text,integer,integer,boolean,boolean,boolean,boolean,boolean,text,text)') IS NULL THEN
  EXECUTE 'ALTER FUNCTION telemetry.open_lifecycle(uuid,uuid,uuid,uuid,text,text,text,integer,integer,boolean,boolean,boolean,boolean,boolean,text,text) RENAME TO open_lifecycle_c2_legacy';
 END IF;
 IF to_regprocedure('telemetry.append_lifecycle_event_c2_legacy(uuid,uuid,uuid,text,timestamp with time zone)') IS NULL THEN
  EXECUTE 'ALTER FUNCTION telemetry.append_lifecycle_event(uuid,uuid,uuid,text,timestamp with time zone) RENAME TO append_lifecycle_event_c2_legacy';
 END IF;
 IF to_regprocedure('telemetry.close_lifecycle_c2_legacy(uuid,uuid,text)') IS NULL THEN
  EXECUTE 'ALTER FUNCTION telemetry.close_lifecycle(uuid,uuid,text) RENAME TO close_lifecycle_c2_legacy';
 END IF;
END $$;

REVOKE ALL ON FUNCTION telemetry.open_lifecycle_c2_legacy(UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,INTEGER,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,TEXT,TEXT) FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter,telemetry_operator;
REVOKE ALL ON FUNCTION telemetry.append_lifecycle_event_c2_legacy(UUID,UUID,UUID,TEXT,TIMESTAMPTZ) FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter,telemetry_operator;
REVOKE ALL ON FUNCTION telemetry.close_lifecycle_c2_legacy(UUID,UUID,TEXT) FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter,telemetry_operator;

CREATE OR REPLACE FUNCTION telemetry.open_lifecycle(
 p_project UUID,p_task UUID,p_manifest UUID,p_lifecycle UUID,p_contract_hmac TEXT,p_key_version TEXT,
 p_task_size TEXT,p_files INTEGER,p_packages INTEGER,p_schema_migration BOOLEAN,p_auth_rls BOOLEAN,
 p_security_isolation BOOLEAN,p_recovery_lease BOOLEAN,p_public_contract BOOLEAN,p_source_sha TEXT,p_manifest_version TEXT
) RETURNS TABLE(lifecycle_id UUID,disposition TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM telemetry.assert_operator(p_project);
 IF p_contract_hmac IS NULL OR p_source_sha IS NULL OR p_task_size IS NULL THEN
  RAISE EXCEPTION 'Invalid lifecycle manifest' USING ERRCODE='22023';
 END IF;
 RETURN QUERY SELECT * FROM telemetry.open_lifecycle_c2_legacy(p_project,p_task,p_manifest,p_lifecycle,p_contract_hmac,
  p_key_version,p_task_size,p_files,p_packages,p_schema_migration,p_auth_rls,p_security_isolation,p_recovery_lease,
  p_public_contract,p_source_sha,p_manifest_version);
END $$;
ALTER FUNCTION telemetry.open_lifecycle(UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,INTEGER,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,TEXT,TEXT) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.open_lifecycle(UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,INTEGER,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,TEXT,TEXT) FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter;
GRANT EXECUTE ON FUNCTION telemetry.open_lifecycle(UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,INTEGER,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,BOOLEAN,TEXT,TEXT) TO telemetry_operator;

CREATE OR REPLACE FUNCTION telemetry.append_lifecycle_event(p_project UUID,p_lifecycle UUID,p_event UUID,p_kind TEXT,p_cutoff TIMESTAMPTZ DEFAULT NULL)
RETURNS TABLE(sequence BIGINT,event_digest TEXT,disposition TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM telemetry.assert_operator(p_project);
 IF p_lifecycle IS NULL OR p_event IS NULL OR p_kind IS NULL THEN
  RAISE EXCEPTION 'Invalid lifecycle event' USING ERRCODE='22023';
 END IF;
 -- Serialize before the legacy duplicate lookup so concurrent identical event IDs
 -- observe the committed first receipt instead of racing on the global PK.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_project::text||':'||p_lifecycle::text,2402));
 RETURN QUERY SELECT * FROM telemetry.append_lifecycle_event_c2_legacy(p_project,p_lifecycle,p_event,p_kind,p_cutoff);
END $$;
ALTER FUNCTION telemetry.append_lifecycle_event(UUID,UUID,UUID,TEXT,TIMESTAMPTZ) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.append_lifecycle_event(UUID,UUID,UUID,TEXT,TIMESTAMPTZ) FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter;
GRANT EXECUTE ON FUNCTION telemetry.append_lifecycle_event(UUID,UUID,UUID,TEXT,TIMESTAMPTZ) TO telemetry_operator;

CREATE OR REPLACE FUNCTION telemetry.close_lifecycle(p_project UUID,p_lifecycle UUID,p_outcome TEXT) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM telemetry.assert_operator(p_project);
 IF p_outcome IS NULL THEN RAISE EXCEPTION 'Invalid lifecycle close' USING ERRCODE='22023'; END IF;
 PERFORM telemetry.close_lifecycle_c2_legacy(p_project,p_lifecycle,p_outcome);
END $$;
ALTER FUNCTION telemetry.close_lifecycle(UUID,UUID,TEXT) OWNER TO telemetry_owner;
REVOKE ALL ON FUNCTION telemetry.close_lifecycle(UUID,UUID,TEXT) FROM PUBLIC,app_runtime,telemetry_ingestor,telemetry_reporter;
GRANT EXECUTE ON FUNCTION telemetry.close_lifecycle(UUID,UUID,TEXT) TO telemetry_operator;
COMMIT;
