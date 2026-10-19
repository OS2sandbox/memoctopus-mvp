-- The personal-template share LINK (a server-stored token + import page) was removed; only the
-- stateless share CODE remains. This drops the table that backed the link. Idempotent.
DROP TABLE IF EXISTS "public"."shared_skabeloner";
