CREATE TABLE "external_roles" (
	"kind" text NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_roles_kind_identifier_pk" PRIMARY KEY("kind","identifier"),
	CONSTRAINT "external_roles_kind_check" CHECK ("external_roles"."kind" in ('role', 'group')),
	CONSTRAINT "external_roles_source_check" CHECK ("external_roles"."source" in ('rollekatalog', 'config', 'claims')),
	CONSTRAINT "external_roles_identifier_check" CHECK (char_length("external_roles"."identifier") between 1 and 200),
	CONSTRAINT "external_roles_name_check" CHECK (char_length("external_roles"."name") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "user_external_roles" (
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"identifier" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_external_roles_user_id_kind_identifier_pk" PRIMARY KEY("user_id","kind","identifier")
);
--> statement-breakpoint
ALTER TABLE "directory_users" DROP CONSTRAINT "directory_users_source_check";--> statement-breakpoint
ALTER TABLE "org_units" DROP CONSTRAINT "org_units_source_check";--> statement-breakpoint
ALTER TABLE "role_assignments" DROP CONSTRAINT "role_assignments_source_check";--> statement-breakpoint
ALTER TABLE "user_external_roles" ADD CONSTRAINT "user_external_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_external_roles" ADD CONSTRAINT "user_external_roles_role_fk" FOREIGN KEY ("kind","identifier") REFERENCES "public"."external_roles"("kind","identifier") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_external_roles_role_idx" ON "user_external_roles" USING btree ("kind","identifier");--> statement-breakpoint
ALTER TABLE "directory_users" ADD CONSTRAINT "directory_users_source_check" CHECK ("source" in ('local', 'rollekatalog', 'claims'));--> statement-breakpoint
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_source_check" CHECK ("source" in ('local', 'rollekatalog', 'claims'));--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_source_check" CHECK ("source" in ('local', 'rollekatalog', 'claims'));