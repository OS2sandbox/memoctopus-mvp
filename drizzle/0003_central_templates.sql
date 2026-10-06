-- The name and change_note CHECKs count only meaningful characters: whitespace and invisible
-- characters are stripped first. The bracket class is a hand-kept mirror of the app rule in
-- src/lib/skabeloner/central-schemas.ts (\p{Default_Ignorable_Code_Point}, Cc/Cf, Unicode
-- White_Space and the blank letters U+115F, U+1160, U+2800, U+3164, U+FFA0), written with
-- explicit \u / \U escapes so it does not depend on the database locale. The app is the
-- primary gate; this is the backstop for writers that bypass it. Keep both in sync.
CREATE TABLE "central_template_targets" (
	"template_id" uuid NOT NULL,
	"org_unit_uuid" uuid NOT NULL,
	"include_descendants" boolean DEFAULT true NOT NULL,
	CONSTRAINT "central_template_targets_template_id_org_unit_uuid_pk" PRIMARY KEY("template_id","org_unit_uuid")
);
--> statement-breakpoint
CREATE TABLE "central_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"change_type" text NOT NULL,
	"change_note" text NOT NULL,
	"changed_by_user_id" text,
	"changed_by_name" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content" jsonb NOT NULL,
	"targets" jsonb NOT NULL,
	CONSTRAINT "central_template_versions_template_version_unique" UNIQUE("template_id","version"),
	CONSTRAINT "central_template_versions_version_check" CHECK ("central_template_versions"."version" >= 1),
	CONSTRAINT "central_template_versions_change_type_check" CHECK ("central_template_versions"."change_type" in ('create', 'update', 'retarget', 'archive', 'restore')),
	CONSTRAINT "central_template_versions_change_note_check" CHECK (char_length(regexp_replace("central_template_versions"."change_note", '[[:space:]\u0085\u00A0\u00AD\u034F\u115F\u1160\u1680\u17B4\u17B5\u180B-\u180F\u2000-\u200F\u2028-\u202F\u205F-\u206F\u2800\u3000\u3164\uFE00-\uFE0F\uFEFF\uFFA0\U000E0000-\U000E0FFF]', '', 'g')) >= 10 and char_length("central_template_versions"."change_note") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "central_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_org_unit_uuid" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"prompt" text NOT NULL,
	"include_deltagere" boolean DEFAULT false NOT NULL,
	"include_beslutningspunkter" boolean DEFAULT false NOT NULL,
	"include_dagsorden" boolean DEFAULT false NOT NULL,
	"include_dato" boolean DEFAULT false NOT NULL,
	"allow_user_instruction" boolean DEFAULT false NOT NULL,
	"allow_toggle_overrides" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "central_templates_status_check" CHECK ("central_templates"."status" in ('active', 'archived')),
	CONSTRAINT "central_templates_name_check" CHECK (char_length(regexp_replace("central_templates"."name", '[[:space:]\u0085\u00A0\u00AD\u034F\u115F\u1160\u1680\u17B4\u17B5\u180B-\u180F\u2000-\u200F\u2028-\u202F\u205F-\u206F\u2800\u3000\u3164\uFE00-\uFE0F\uFEFF\uFFA0\U000E0000-\U000E0FFF]', '', 'g')) >= 1 and char_length("central_templates"."name") <= 120),
	CONSTRAINT "central_templates_description_check" CHECK (char_length("central_templates"."description") <= 1000),
	CONSTRAINT "central_templates_prompt_check" CHECK (btrim("central_templates"."prompt") <> '' and char_length("central_templates"."prompt") <= 20000),
	CONSTRAINT "central_templates_version_check" CHECK ("central_templates"."current_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "central_template_targets" ADD CONSTRAINT "central_template_targets_template_id_central_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."central_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "central_template_targets" ADD CONSTRAINT "central_template_targets_org_unit_uuid_org_units_uuid_fk" FOREIGN KEY ("org_unit_uuid") REFERENCES "public"."org_units"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "central_template_versions" ADD CONSTRAINT "central_template_versions_template_id_central_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."central_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "central_templates" ADD CONSTRAINT "central_templates_owner_org_unit_uuid_org_units_uuid_fk" FOREIGN KEY ("owner_org_unit_uuid") REFERENCES "public"."org_units"("uuid") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "central_template_targets_org_unit_idx" ON "central_template_targets" USING btree ("org_unit_uuid");--> statement-breakpoint
CREATE INDEX "central_templates_owner_idx" ON "central_templates" USING btree ("owner_org_unit_uuid");
--> statement-breakpoint
-- Hand-appended (drizzle-kit cannot express triggers). central_template_versions is the
-- changelog and is append-only: UPDATE, DELETE and TRUNCATE are always refused, with no
-- prune bypass. Templates are archived, never deleted, so no legitimate path needs more.
-- Like audit_events this guards against bugs and casual misuse; it does NOT stop a
-- database superuser or the owning role from dropping the triggers on purpose.
CREATE FUNCTION "central_template_versions_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'central_template_versions is append-only: % is not allowed', TG_OP
		USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "central_template_versions_no_update_delete"
	BEFORE UPDATE OR DELETE ON "central_template_versions"
	FOR EACH ROW EXECUTE FUNCTION "central_template_versions_guard"();
--> statement-breakpoint
CREATE TRIGGER "central_template_versions_no_truncate"
	BEFORE TRUNCATE ON "central_template_versions"
	FOR EACH STATEMENT EXECUTE FUNCTION "central_template_versions_guard"();
