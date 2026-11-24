-- An event shown on the Bar Channel as only its picture, filling the screen.
ALTER TABLE events ADD COLUMN picture_only INTEGER NOT NULL DEFAULT 0;
