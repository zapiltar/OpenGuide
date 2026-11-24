-- A takeover that is just the special's uploaded picture, filling the screen with no text over it.
-- Stored as display 'takeover' with this flag, as the display column only allows 'banner' and 'takeover'.
ALTER TABLE specials ADD COLUMN picture_only INTEGER NOT NULL DEFAULT 0;
