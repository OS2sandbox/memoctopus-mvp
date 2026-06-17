-- migrate:up
-- Create history_entries table for storing user's history
CREATE TABLE history_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  title VARCHAR(200) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
);

-- Create history_assets table for storing assets (transcripts and prompts)
CREATE TABLE history_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  history_entry_id UUID NOT NULL,
  asset_kind VARCHAR(20) NOT NULL CHECK (asset_kind IN ('transcript', 'prompt')),
  asset_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (history_entry_id) REFERENCES history_entries(id) ON DELETE CASCADE
);

-- Create indexes for efficient querying
CREATE INDEX idx_history_entries_user_id ON history_entries(user_id);
CREATE INDEX idx_history_entries_created_at ON history_entries(created_at DESC);
CREATE INDEX idx_history_assets_history_entry_id ON history_assets(history_entry_id);

-- migrate:down
DROP TABLE IF EXISTS history_assets;
DROP TABLE IF EXISTS history_entries;
