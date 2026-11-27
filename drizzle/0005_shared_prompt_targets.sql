-- Shared prompts for roles and groups. These statements were first folded into 0004, which had
-- already been applied to scratch and dev databases, so every statement here is safe to run on a
-- database that already has them (IF NOT EXISTS, or DROP ... IF EXISTS before the ADD).
CREATE TABLE IF NOT EXISTS "central_template_principal_targets" (
	"template_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"identifier" text NOT NULL,
	CONSTRAINT "central_template_principal_targets_template_id_kind_identifier_pk" PRIMARY KEY("template_id","kind","identifier")
);
--> statement-breakpoint
ALTER TABLE "central_templates" ALTER COLUMN "owner_org_unit_uuid" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "central_template_versions" ADD COLUMN IF NOT EXISTS "principal_targets" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "central_template_versions" DROP CONSTRAINT IF EXISTS "central_template_versions_principal_targets_check";--> statement-breakpoint
ALTER TABLE "central_template_versions" ADD CONSTRAINT "central_template_versions_principal_targets_check" CHECK (jsonb_typeof("central_template_versions"."principal_targets") = 'array');--> statement-breakpoint
ALTER TABLE "central_template_principal_targets" DROP CONSTRAINT IF EXISTS "central_template_principal_targets_template_id_central_templates_id_fk";--> statement-breakpoint
ALTER TABLE "central_template_principal_targets" ADD CONSTRAINT "central_template_principal_targets_template_id_central_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."central_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "central_template_principal_targets" DROP CONSTRAINT IF EXISTS "central_template_principal_targets_role_fk";--> statement-breakpoint
ALTER TABLE "central_template_principal_targets" ADD CONSTRAINT "central_template_principal_targets_role_fk" FOREIGN KEY ("kind","identifier") REFERENCES "public"."external_roles"("kind","identifier") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "central_template_principal_targets_role_idx" ON "central_template_principal_targets" USING btree ("kind","identifier");
