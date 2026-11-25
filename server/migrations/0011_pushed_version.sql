-- TVs get a bar's changes when someone presses "Send changes to TVs" (or at their hourly check). This is the
-- feed version last sent, so the site can say when there are changes the TVs haven't got yet.
ALTER TABLE venues ADD COLUMN pushed_version INTEGER NOT NULL DEFAULT 0;
UPDATE venues SET pushed_version = feed_version;
