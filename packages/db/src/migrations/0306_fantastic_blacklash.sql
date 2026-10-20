ALTER TABLE "routines" ADD COLUMN "standing_issue_id" uuid;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_standing_issue_id_issues_id_fk" FOREIGN KEY ("standing_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routines_standing_issue_idx" ON "routines" USING btree ("standing_issue_id");
