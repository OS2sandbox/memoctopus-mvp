-- migrate:up
CREATE TABLE prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  creator_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Beslutningsreferat', 'API', 'To do liste', 'Detaljeret referat', 'Kort referat')),
  is_favorite BOOLEAN NOT NULL DEFAULT false,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (creator_id) REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX idx_prompts_creator_id ON prompts(creator_id);
CREATE INDEX idx_prompts_category ON prompts(category);

-- migrate:down
DROP TABLE IF EXISTS prompts;

