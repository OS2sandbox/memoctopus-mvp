-- migrate:up
-- Remove the global is_favorite column from prompts table
ALTER TABLE prompts DROP COLUMN is_favorite;

-- Create a junction table for user-specific prompt favorites
CREATE TABLE user_prompt_favorites (
  user_id TEXT NOT NULL,
  prompt_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY (user_id, prompt_id),
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
  FOREIGN KEY (prompt_id) REFERENCES prompts(id) ON DELETE CASCADE
);

CREATE INDEX idx_user_prompt_favorites_user_id ON user_prompt_favorites(user_id);
CREATE INDEX idx_user_prompt_favorites_prompt_id ON user_prompt_favorites(prompt_id);

-- migrate:down
DROP TABLE IF EXISTS user_prompt_favorites;
ALTER TABLE prompts ADD COLUMN is_favorite BOOLEAN NOT NULL DEFAULT false;

