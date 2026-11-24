-- Bars, the people who manage them, their linked TVs, and what those TVs show.
-- Times are Unix milliseconds (UTC). "screens" columns hold a JSON array of screen ids, or NULL for every screen.

CREATE TABLE venues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT,
  logo_key TEXT,
  timezone TEXT NOT NULL,
  feed_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE staff (
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (venue_id, email)
);
CREATE INDEX staff_by_email ON staff(email);

CREATE TABLE screens (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  last_seen INTEGER,
  app_version TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX screens_by_venue ON screens(venue_id);

CREATE TABLE pairings (
  code TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  screen_id TEXT REFERENCES screens(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE menus (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'list')),
  image_key TEXT,
  sections TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  screens TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX menus_by_venue ON menus(venue_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  image_key TEXT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  screens TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX events_by_venue ON events(venue_id, starts_at);

CREATE TABLE specials (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  text TEXT,
  image_key TEXT,
  -- {"type":"once","start":ms,"end":ms} or {"type":"weekly","days":[0-6, Sunday is 0],"start":"HH:MM","end":"HH:MM"}
  schedule TEXT NOT NULL,
  display TEXT NOT NULL CHECK (display IN ('banner', 'takeover')),
  -- Seconds on screen each time it appears. NULL keeps a banner up until the special ends.
  timeout_seconds INTEGER,
  -- Minutes between appearances while the special is on. NULL shows it once per occurrence.
  repeat_minutes INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  screens TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX specials_by_venue ON specials(venue_id);
