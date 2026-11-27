-- A central template belongs to the person who created it, not to an org unit: a bygger
-- manages the templates they created, an administrator (template.manage_all) all of them.
-- The creator is taken from each template's first changelog version (written by the same
-- transaction that created it), so existing templates keep a creator. No role is tied to org units
-- any more either: the Rollekatalog mirror's unit-scoped rows are deleted, so the next sync inserts
-- one unscoped row per person and role instead of counting every scoped row as a removal (which
-- would trip its removal threshold). Until that sync those people lack the role (fail closed).
-- Local rows are left alone: a unit on them is ignored for every capability that is not global-only.
-- Idempotent.
ALTER TABLE "central_templates" ADD COLUMN IF NOT EXISTS "created_by_user_id" text;--> statement-breakpoint
UPDATE "central_templates" ct SET "created_by_user_id" = v."changed_by_user_id"
  FROM "central_template_versions" v
 WHERE v."template_id" = ct."id" AND v."version" = 1 AND ct."created_by_user_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "central_templates_created_by_idx" ON "central_templates" USING btree ("created_by_user_id");--> statement-breakpoint
DROP INDEX IF EXISTS "central_templates_owner_idx";--> statement-breakpoint
ALTER TABLE "central_templates" DROP COLUMN IF EXISTS "owner_org_unit_uuid";--> statement-breakpoint
DELETE FROM "role_assignments" WHERE "source" = 'rollekatalog' AND "scope_org_unit_uuid" IS NOT NULL;
