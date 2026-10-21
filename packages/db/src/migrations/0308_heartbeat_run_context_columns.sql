-- paperclip:migration-no-transaction
-- The heartbeat scheduler read the issue and task ids out of the context
-- snapshot of every candidate run. The snapshot is a TOASTed jsonb document
-- of about 55 KB, so the read detoasted the whole document for every row and
-- starved the API connection pool.
--
-- The ids become real columns. The read paths use the columns, so the
-- scheduler read is an index-only scan. A trigger keeps the columns and the
-- persisted snapshot in shape, so every write path stays correct without a
-- change in each of them.
--
-- The migration runs outside a transaction because the indexes are built
-- concurrently. A concurrent build cannot run inside a transaction block.
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_issue_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_task_id" text;--> statement-breakpoint
UPDATE "heartbeat_runs" SET "context_issue_id" = nullif("context_snapshot" ->> 'issueId', ''), "context_task_id" = nullif("context_snapshot" ->> 'taskId', '') WHERE "context_snapshot" IS NOT NULL AND ("context_snapshot" ->> 'issueId' IS NOT NULL OR "context_snapshot" ->> 'taskId' IS NOT NULL);--> statement-breakpoint
DROP INDEX IF EXISTS "dt_perf_hr_company_agent_created_ctx_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "dt_perf_hr_company_agent_created_ctx_idx" ON "heartbeat_runs" USING btree ("company_id","agent_id","created_at" DESC,"context_issue_id","context_task_id");--> statement-breakpoint
DROP INDEX IF EXISTS "heartbeat_runs_company_context_issue_created_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "heartbeat_runs_company_context_issue_created_idx" ON "heartbeat_runs" USING btree ("company_id","context_issue_id","created_at" DESC);--> statement-breakpoint
DROP INDEX IF EXISTS "dt_perf_hre_company_type_run_msg_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "dt_perf_hre_company_type_run_msg_idx" ON "heartbeat_run_events" USING btree ("company_id","event_type","run_id","id" DESC) WHERE "heartbeat_run_events"."message" like 'Bounded retry exhausted%';--> statement-breakpoint
CREATE OR REPLACE FUNCTION "paperclip_slim_heartbeat_run_context_snapshot"() RETURNS trigger LANGUAGE plpgsql AS $paperclip$
DECLARE
  slim_snapshot jsonb;
  slim_wake jsonb;
BEGIN
  -- A run without a snapshot has no ids to mirror.
  IF NEW.context_snapshot IS NULL THEN
    RETURN NEW;
  END IF;

  -- A write that does not change the snapshot keeps the stored snapshot and
  -- the stored ids as they are.
  IF TG_OP = 'UPDATE' AND NEW.context_snapshot IS NOT DISTINCT FROM OLD.context_snapshot THEN
    RETURN NEW;
  END IF;

  -- The rendered prompt is rebuilt at dispatch time. It must not be stored a
  -- second time in the snapshot of the run.
  slim_snapshot := NEW.context_snapshot
    - 'paperclipTaskMarkdown'::text
    - 'paperclipTaskMarkdownCompact'::text
    - 'paperclipTaskMarkdownAssignment'::text
    - 'paperclipTaskMarkdownAssignmentCompact'::text
    - 'paperclipWakeComment'::text
    - 'paperclipFreshSessionHandoffMarkdown'::text;

  -- The wake payload keeps the small proof fields that the merge and the
  -- external chat presentation read. It drops the copy of the continuation and
  -- of the continuation summary, because the snapshot already holds them, and
  -- it reduces the copy of the issue to its id. The comments stay, because
  -- the continuation code reads them to find out whether a human comment was
  -- delivered.
  IF jsonb_typeof(slim_snapshot -> 'paperclipWake') = 'object' THEN
    -- The parentheses matter. In PL/pgSQL the arrow binds weaker than the
    -- minus sign, so an unparenthesized arrow would swallow the keys.
    slim_wake := (slim_snapshot -> 'paperclipWake')
      - 'executionContinuation'::text
      - 'continuationSummary'::text;
    IF jsonb_typeof(slim_wake -> 'issue') = 'object'
      AND jsonb_typeof(slim_wake -> 'issue' -> 'id') = 'string' THEN
      slim_wake := jsonb_set(slim_wake, '{issue}', jsonb_build_object('id', slim_wake -> 'issue' -> 'id'));
    END IF;
    slim_snapshot := jsonb_set(slim_snapshot, '{paperclipWake}', slim_wake);
  END IF;

  NEW.context_snapshot := slim_snapshot;
  NEW.context_issue_id := nullif(slim_snapshot ->> 'issueId', '');
  NEW.context_task_id := nullif(slim_snapshot ->> 'taskId', '');
  RETURN NEW;
END;
$paperclip$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "heartbeat_runs_context_snapshot_sync_trg" ON "heartbeat_runs";--> statement-breakpoint
CREATE TRIGGER "heartbeat_runs_context_snapshot_sync_trg" BEFORE INSERT OR UPDATE OF "context_snapshot" ON "heartbeat_runs" FOR EACH ROW EXECUTE FUNCTION "paperclip_slim_heartbeat_run_context_snapshot"();
