CREATE TABLE "permission_grant_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text DEFAULT 'permission_grant' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	"scope" jsonb,
	"justification" text NOT NULL,
	"proposed_by_agent_id" uuid NOT NULL,
	"origin_run_id" uuid NOT NULL,
	"resolved_by_user_id" text,
	"resolution_reason" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_grant_proposals_kind_check" CHECK ("permission_grant_proposals"."kind" = 'permission_grant'),
	CONSTRAINT "permission_grant_proposals_status_check" CHECK ("permission_grant_proposals"."status" in ('pending', 'approved', 'rejected', 'withdrawn'))
);
--> statement-breakpoint
ALTER TABLE "permission_grant_proposals" ADD CONSTRAINT "permission_grant_proposals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grant_proposals" ADD CONSTRAINT "permission_grant_proposals_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grant_proposals" ADD CONSTRAINT "permission_grant_proposals_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grant_proposals" ADD CONSTRAINT "permission_grant_proposals_origin_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("origin_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "permission_grant_proposals_company_status_idx" ON "permission_grant_proposals" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "permission_grant_proposals_proposer_status_idx" ON "permission_grant_proposals" USING btree ("proposed_by_agent_id","status");