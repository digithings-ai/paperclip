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
CREATE OR REPLACE FUNCTION "paperclip_slim_heartbeat_run_context_snapshot"() RETURNS trigger LANGUAGE plpgsql AS $paperclip$
DECLARE
  slim_snapshot jsonb;
  slim_continuation jsonb;
  slim_messages jsonb;
BEGIN
  -- A snapshot that is not a JSON object has no ids and no envelope. The
  -- mirrored ids are cleared, because a stale id makes a run look like it
  -- belongs to an issue that the snapshot does not name.
  IF NEW.context_snapshot IS NULL OR jsonb_typeof(NEW.context_snapshot) <> 'object' THEN
    NEW.context_issue_id := NULL;
    NEW.context_task_id := NULL;
    RETURN NEW;
  END IF;

  -- The wake payload and the rendered prompt are not touched. Production code
  -- reads the issue work mode, the continuation summary, and the rendered
  -- wake comments from the stored snapshot.
  slim_snapshot := NEW.context_snapshot;

  -- The continuation envelope repeats the body of every comment of the issue.
  -- The bodies live in the comment table, and the envelope needs them only to
  -- find out whether a comment changed. A digest of the body answers that
  -- question and keeps the stored snapshot small.
  IF jsonb_typeof(slim_snapshot -> 'executionContinuation') = 'object' THEN
    slim_continuation := slim_snapshot -> 'executionContinuation';
    IF jsonb_typeof(slim_continuation -> 'messages') = 'array' THEN
      SELECT coalesce(jsonb_agg(
        CASE
          WHEN jsonb_typeof(element.message) = 'object'
            AND jsonb_typeof(element.message -> 'body') = 'string'
          THEN
            (element.message - 'body'::text)
            || jsonb_build_object(
              'bodyDigest',
              encode(sha256(convert_to(element.message ->> 'body', 'UTF8')), 'hex')
            )
          ELSE element.message
        END
      ), '[]'::jsonb)
      INTO slim_messages
      FROM jsonb_array_elements(slim_continuation -> 'messages') AS element(message);
      slim_continuation := (slim_continuation - 'messages'::text)
        || jsonb_build_object('messages', slim_messages);
      slim_snapshot := (slim_snapshot - 'executionContinuation'::text)
        || jsonb_build_object('executionContinuation', slim_continuation);
    END IF;
  END IF;

  NEW.context_snapshot := slim_snapshot;
  -- The ids keep the text form of the snapshot. The read paths that used the
  -- snapshot read the same text, so the mirrored value is the same value.
  NEW.context_issue_id := slim_snapshot ->> 'issueId';
  NEW.context_task_id := slim_snapshot ->> 'taskId';
  RETURN NEW;
END;
$paperclip$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "heartbeat_runs_context_snapshot_sync_trg" ON "heartbeat_runs";--> statement-breakpoint
CREATE TRIGGER "heartbeat_runs_context_snapshot_sync_trg" BEFORE INSERT OR UPDATE OF "context_snapshot" ON "heartbeat_runs" FOR EACH ROW EXECUTE FUNCTION "paperclip_slim_heartbeat_run_context_snapshot"();--> statement-breakpoint
UPDATE "heartbeat_runs" SET "context_issue_id" = "context_snapshot" ->> 'issueId', "context_task_id" = "context_snapshot" ->> 'taskId' WHERE "context_snapshot" IS NOT NULL AND jsonb_typeof("context_snapshot") = 'object' AND ("context_snapshot" ->> 'issueId' IS NOT NULL OR "context_snapshot" ->> 'taskId' IS NOT NULL);--> statement-breakpoint
DROP INDEX IF EXISTS "dt_perf_hr_company_agent_created_ctx_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "dt_perf_hr_company_agent_created_ctx_idx" ON "heartbeat_runs" USING btree ("company_id","agent_id","created_at" DESC,"context_issue_id","context_task_id");--> statement-breakpoint
DROP INDEX IF EXISTS "heartbeat_runs_company_context_issue_created_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "heartbeat_runs_company_context_issue_created_idx" ON "heartbeat_runs" USING btree ("company_id","context_issue_id","created_at" DESC);--> statement-breakpoint
DROP INDEX IF EXISTS "dt_perf_hre_company_type_run_msg_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "dt_perf_hre_company_type_run_msg_idx" ON "heartbeat_run_events" USING btree ("company_id","event_type","run_id","id" DESC) WHERE "heartbeat_run_events"."message" like 'Bounded retry exhausted%';
