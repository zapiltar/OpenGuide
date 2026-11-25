-- Bingo on the bar's TVs. Each bar has one game at a time; the TV hosting it calls the numbers.
ALTER TABLE venues ADD COLUMN bingo INTEGER NOT NULL DEFAULT 1;

CREATE TABLE bingo_games (
  venue_id TEXT PRIMARY KEY REFERENCES venues(id) ON DELETE CASCADE,
  -- Counts up with each new game, so TVs can tell a new game from the same one.
  game INTEGER NOT NULL DEFAULT 1,
  -- The numbers called so far, in order, as a JSON list.
  called TEXT NOT NULL DEFAULT '[]',
  host_screen_id TEXT,
  -- Goes up with every change, for ETags and so two TVs can't both call at once.
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
