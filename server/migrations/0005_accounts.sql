-- Accounts for the admin site, replacing Cloudflare Access. Invite-only: bars are created by the site owner,
-- and people join a bar through a one-time invite link. Every token below is stored only as a SHA-256 hash.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  -- "pbkdf2-sha256$<iterations>$<salt>$<hash>", base64url
  password_hash TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_by_user ON sessions(user_id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('manager', 'staff')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX invites_by_venue ON invites(venue_id);

CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Wrong-password attempts per address, in 15-minute windows.
CREATE TABLE login_limits (
  ip TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);

-- A bar's people: 'manager' can also invite and remove staff; 'staff' manage the bar's content.
ALTER TABLE staff ADD COLUMN role TEXT NOT NULL DEFAULT 'staff';
