-- Three user types (Admin, Bygger, Bruger) matching the OS2ai roles. The role keys are plain text,
-- so this only renames the stored keys and drops the removed log-reader role. Idempotent: a second
-- run finds nothing left to change. A removed key would grant nothing anyway (fail closed); this
-- keeps existing local grants (and the last administrator) working across the rename.
DELETE FROM "role_assignments" WHERE "role_key" = 'tt-logleser';--> statement-breakpoint
UPDATE "role_assignments" SET "role_key" = 'admin' WHERE "role_key" = 'tt-administrator';--> statement-breakpoint
UPDATE "role_assignments" SET "role_key" = 'bygger' WHERE "role_key" = 'tt-skabelonansvarlig';--> statement-breakpoint
UPDATE "role_assignments" SET "role_key" = 'bruger' WHERE "role_key" = 'tt-bruger';
