CREATE TABLE "directory_users" (
	"uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ext_uuid" uuid,
	"ext_user_id" text,
	"name" text NOT NULL,
	"email" text,
	"disabled" boolean DEFAULT false NOT NULL,
	"app_user_id" text,
	"source" text NOT NULL,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_users_ext_uuid_unique" UNIQUE("ext_uuid"),
	CONSTRAINT "directory_users_app_user_id_unique" UNIQUE("app_user_id"),
	CONSTRAINT "directory_users_source_check" CHECK ("source" in ('local', 'rollekatalog'))
);
--> statement-breakpoint
CREATE TABLE "external_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"subject" text NOT NULL,
	"claims" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_identities_provider_subject_unique" UNIQUE("provider_id","subject")
);
--> statement-breakpoint
CREATE TABLE "org_unit_members" (
	"directory_user_uuid" uuid NOT NULL,
	"org_unit_uuid" uuid NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"title" text,
	CONSTRAINT "org_unit_members_directory_user_uuid_org_unit_uuid_pk" PRIMARY KEY("directory_user_uuid","org_unit_uuid")
);
--> statement-breakpoint
CREATE TABLE "org_units" (
	"uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"parent_uuid" uuid,
	"source" text NOT NULL,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_units_source_check" CHECK ("source" in ('local', 'rollekatalog'))
);
--> statement-breakpoint
CREATE TABLE "role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"directory_user_uuid" uuid NOT NULL,
	"role_key" text NOT NULL,
	"scope_org_unit_uuid" uuid,
	"include_descendants" boolean DEFAULT true NOT NULL,
	"source" text NOT NULL,
	"start_date" timestamp with time zone,
	"stop_date" timestamp with time zone,
	"created_by_user_id" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_assignments_user_role_scope_source_unique" UNIQUE NULLS NOT DISTINCT("directory_user_uuid","role_key","scope_org_unit_uuid","source"),
	CONSTRAINT "role_assignments_source_check" CHECK ("source" in ('local', 'rollekatalog')),
	CONSTRAINT "role_assignments_dates_check" CHECK ("role_assignments"."start_date" is null or "role_assignments"."stop_date" is null or "role_assignments"."stop_date" > "role_assignments"."start_date")
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"counts" jsonb,
	"error_code" text,
	CONSTRAINT "sync_runs_status_check" CHECK ("sync_runs"."status" in ('running', 'success', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "system_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "directory_users" ADD CONSTRAINT "directory_users_app_user_id_users_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_unit_members" ADD CONSTRAINT "org_unit_members_directory_user_uuid_directory_users_uuid_fk" FOREIGN KEY ("directory_user_uuid") REFERENCES "public"."directory_users"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_unit_members" ADD CONSTRAINT "org_unit_members_org_unit_uuid_org_units_uuid_fk" FOREIGN KEY ("org_unit_uuid") REFERENCES "public"."org_units"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_parent_uuid_org_units_uuid_fk" FOREIGN KEY ("parent_uuid") REFERENCES "public"."org_units"("uuid") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_directory_user_uuid_directory_users_uuid_fk" FOREIGN KEY ("directory_user_uuid") REFERENCES "public"."directory_users"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_scope_org_unit_uuid_org_units_uuid_fk" FOREIGN KEY ("scope_org_unit_uuid") REFERENCES "public"."org_units"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_identities_user_id_idx" ON "external_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "org_unit_members_org_unit_idx" ON "org_unit_members" USING btree ("org_unit_uuid");--> statement-breakpoint
CREATE INDEX "org_units_parent_uuid_idx" ON "org_units" USING btree ("parent_uuid");--> statement-breakpoint
CREATE INDEX "role_assignments_scope_idx" ON "role_assignments" USING btree ("scope_org_unit_uuid");