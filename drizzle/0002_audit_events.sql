CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"event_type" text NOT NULL,
	"outcome" text NOT NULL,
	"actor_user_id" text,
	"actor_name" text,
	"actor_org_unit_uuid" uuid,
	"entity_type" text,
	"entity_id" text,
	"secondary_entity_type" text,
	"secondary_entity_id" text,
	"ip_address" text,
	"user_agent" text,
	"request_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"client_event_id" uuid,
	"client_occurred_at" timestamp with time zone,
	CONSTRAINT "audit_events_source_check" CHECK ("audit_events"."source" in ('server', 'client', 'system')),
	CONSTRAINT "audit_events_outcome_check" CHECK ("audit_events"."outcome" in ('success', 'denied', 'error'))
);
--> statement-breakpoint
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id","id");--> statement-breakpoint
CREATE INDEX "audit_events_event_type_idx" ON "audit_events" USING btree ("event_type","id");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_org_unit_idx" ON "audit_events" USING btree ("actor_org_unit_uuid","id");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_client_event_unique" ON "audit_events" USING btree ("actor_user_id","client_event_id") WHERE "audit_events"."client_event_id" is not null;
--> statement-breakpoint
-- Hand-appended (drizzle-kit cannot express triggers). audit_events is append-only:
-- UPDATE and TRUNCATE are always refused; DELETE only inside a transaction that ran
-- set_config('audit.allow_prune', 'on', true), which only the retention pruner does.
-- This guards against bugs and casual misuse. It does NOT stop a database superuser
-- or the owning role from disabling the triggers or changing the setting on purpose.
CREATE FUNCTION "audit_events_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' AND current_setting('audit.allow_prune', true) = 'on' THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
		USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "audit_events_no_update_delete"
	BEFORE UPDATE OR DELETE ON "audit_events"
	FOR EACH ROW EXECUTE FUNCTION "audit_events_guard"();
--> statement-breakpoint
CREATE TRIGGER "audit_events_no_truncate"
	BEFORE TRUNCATE ON "audit_events"
	FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_guard"();
