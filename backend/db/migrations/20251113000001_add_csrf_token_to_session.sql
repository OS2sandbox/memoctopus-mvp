-- migrate:up
-- Add CSRF token column to session table for CSRF protection
ALTER TABLE session ADD COLUMN csrf_token TEXT UNIQUE;

-- Create index for efficient CSRF token lookups
CREATE INDEX idx_session_csrf_token ON session(csrf_token);

-- migrate:down
DROP INDEX IF EXISTS idx_session_csrf_token;
ALTER TABLE session DROP COLUMN csrf_token;
