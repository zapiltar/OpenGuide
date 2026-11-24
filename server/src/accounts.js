import { HttpError, json, randomToken, readJson, sha256 } from "./http.js";
import * as v from "./validate.js";

// Accounts for the admin site. Invite-only:
// - The site owner's account comes from a one-time setup page, which needs the SETUP_CODE secret and closes
//   once an owner exists. The same code also lets the owner reset their own forgotten password.
// - Everyone else joins a bar through an invite link that the owner or the bar's manager makes and passes on.
// - A forgotten password is reset through a one-time link that the owner or the bar's manager makes.
//
// Passwords are stored as PBKDF2-SHA256 hashes with a random salt. Sessions are random tokens in an HttpOnly,
// SameSite=Lax cookie (Secure and __Host- prefixed over HTTPS), stored only as SHA-256 hashes. Wrong passwords
// lock an account for 15 minutes after 10 tries, and an address after 30 tries in 15 minutes.

const ITERATIONS = 100_000; // The most Workers' PBKDF2 allows.
const SESSION_DAYS = 30;
const DAY = 86_400_000;
export const INVITE_DAYS = 7;
export const RESET_DAYS = 3;
const ACCOUNT_LOCK_AFTER = 10;
const IP_LOCK_AFTER = 30;
const LOCK_MS = 15 * 60_000;
export const MIN_PASSWORD = 10;

// ---------- passwords ----------

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${ITERATIONS}$${b64(salt)}$${b64(await pbkdf2(password, salt, ITERATIONS))}`;
}

/** Compares in constant time, so the time taken doesn't reveal how much of a guess was right. */
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password, stored) {
  const [scheme, iter, salt, hash] = String(stored).split("$");
  if (scheme !== "pbkdf2-sha256") return false;
  return sameBytes(await pbkdf2(password, unb64(salt), Number(iter)), unb64(hash));
}

const sameText = (a, b) => sameBytes(new TextEncoder().encode(String(a)), new TextEncoder().encode(String(b)));

let dummyHash;
/** Checking a password for an email with no account takes as long as for one with, so emails can't be probed. */
async function wasteTime(password) {
  dummyHash ??= await hashPassword("not-a-real-password");
  await verifyPassword(password, dummyHash);
}

function checkNewPassword(password, email) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    throw new HttpError(400, `Use a password of at least ${MIN_PASSWORD} characters`);
  }
  if (password.length > 200) throw new HttpError(400, "That password is too long");
  if (email && password.toLowerCase().includes(email.split("@")[0].toLowerCase()) && email.split("@")[0].length >= 4) {
    throw new HttpError(400, "Your password can't contain your email address");
  }
}

// ---------- sessions ----------

const isHttps = (request) => new URL(request.url).protocol === "https:";
const cookieName = (request) => (isHttps(request) ? "__Host-og_session" : "og_session");

function cookieValue(request) {
  const name = cookieName(request);
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

function setCookie(request, token, maxAgeSeconds) {
  const attrs = [`${cookieName(request)}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (isHttps(request)) attrs.push("Secure");
  return attrs.join("; ");
}

async function startSession(db, request, user, body, status = 200) {
  const token = randomToken();
  const now = Date.now();
  await db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), user.id, now, now + SESSION_DAYS * DAY).run();
  return json(body ?? meOf(user), status, { "Set-Cookie": setCookie(request, token, SESSION_DAYS * 86_400) });
}

const meOf = (u) => ({ email: u.email, name: u.name, owner: u.is_owner === 1 });

/** The signed-in user for [request], or null. Keeps a session in use alive for another 30 days. */
export async function sessionUser(request, env) {
  const token = cookieValue(request);
  if (!token) return null;
  const hash = await sha256(token);
  const now = Date.now();
  const row = await env.DB.prepare(
    "SELECT users.*, sessions.expires_at AS session_expires FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?",
  ).bind(hash).first();
  if (!row || row.session_expires < now) return null;
  // Extend at most once a day, rather than writing on every request.
  if (row.session_expires - now < (SESSION_DAYS - 1) * DAY) {
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").bind(now + SESSION_DAYS * DAY, hash).run();
  }
  return row;
}

// ---------- rate limits ----------

const clientIp = (request) => request.headers.get("CF-Connecting-IP") || "local";

async function ipBlocked(db, ip, now) {
  const row = await db.prepare("SELECT * FROM login_limits WHERE ip = ?").bind(ip).first();
  return row && now - row.window_start < LOCK_MS && row.attempts >= IP_LOCK_AFTER;
}

async function recordFailure(db, ip, user, now) {
  const statements = [
    db.prepare(
      `INSERT INTO login_limits (ip, window_start, attempts) VALUES (?, ?, 1)
       ON CONFLICT(ip) DO UPDATE SET
         attempts = CASE WHEN ? - window_start >= ? THEN 1 ELSE attempts + 1 END,
         window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END`,
    ).bind(ip, now, now, LOCK_MS, now, LOCK_MS, now),
  ];
  if (user) {
    const failed = user.failed_logins + 1;
    statements.push(
      failed >= ACCOUNT_LOCK_AFTER
        ? db.prepare("UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?").bind(now + LOCK_MS, user.id)
        : db.prepare("UPDATE users SET failed_logins = ? WHERE id = ?").bind(failed, user.id),
    );
  }
  await db.batch(statements);
}

function lockedMessage(until, now) {
  const mins = Math.max(1, Math.ceil((until - now) / 60_000));
  return `Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`;
}

/** Checks [email] and [password], counting wrong tries. Returns the user, or throws 401 or 429. */
async function checkLogin(db, request, email, password) {
  const now = Date.now();
  const ip = clientIp(request);
  if (await ipBlocked(db, ip, now)) throw new HttpError(429, "Too many wrong passwords from here. Try again in 15 minutes.");
  const user = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  if (user?.locked_until && user.locked_until > now) throw new HttpError(429, lockedMessage(user.locked_until, now));
  const ok = user ? await verifyPassword(password, user.password_hash) : (await wasteTime(password), false);
  if (!ok) {
    await recordFailure(db, ip, user, now);
    throw new HttpError(401, "Wrong email or password");
  }
  if (user.failed_logins || user.locked_until) {
    await db.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?").bind(user.id).run();
  }
  return user;
}

// ---------- public routes: /api/auth/... ----------

async function ownerExists(db) {
  return !!(await db.prepare("SELECT 1 FROM users WHERE is_owner = 1").first());
}

async function inviteFrom(db, token) {
  const row = await db.prepare(
    "SELECT invites.*, venues.name AS venue_name, venues.display_name FROM invites JOIN venues ON venues.id = invites.venue_id WHERE token_hash = ?",
  ).bind(await sha256(token || "")).first();
  if (!row) throw new HttpError(404, "This invite link isn't valid. It may have been used already or cancelled.");
  if (row.expires_at < Date.now()) throw new HttpError(410, "This invite link has expired. Ask for a new one.");
  return row;
}

async function resetFrom(db, token) {
  const row = await db.prepare(
    "SELECT password_resets.*, users.email FROM password_resets JOIN users ON users.id = password_resets.user_id WHERE token_hash = ?",
  ).bind(await sha256(token || "")).first();
  if (!row) throw new HttpError(404, "This reset link isn't valid. It may have been used already.");
  if (row.expires_at < Date.now()) throw new HttpError(410, "This reset link has expired. Ask for a new one.");
  return row;
}

async function addToVenue(db, venueId, email, role) {
  // Joining as a manager upgrades a staff member; joining as staff never downgrades a manager.
  await db.prepare(
    `INSERT INTO staff (venue_id, email, added_at, role) VALUES (?, ?, ?, ?)
     ON CONFLICT(venue_id, email) DO UPDATE SET role = CASE WHEN excluded.role = 'manager' THEN 'manager' ELSE staff.role END`,
  ).bind(venueId, email, Date.now(), role).run();
}

async function createUser(db, { email, name, password, owner = false }) {
  checkNewPassword(password, email);
  const user = {
    id: crypto.randomUUID(),
    email,
    name,
    password_hash: await hashPassword(password),
    is_owner: owner ? 1 : 0,
    failed_logins: 0,
    created_at: Date.now(),
  };
  const r = await db.prepare(
    "INSERT INTO users (id, email, name, password_hash, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING",
  ).bind(user.id, email, name, user.password_hash, user.is_owner, user.created_at).run();
  if (r.meta.changes !== 1) throw new HttpError(409, "There's already an account with that email. Sign in with it instead.");
  return user;
}

export async function handleAuth(request, env, path) {
  const db = env.DB;
  const method = request.method;
  if (method !== "GET") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, "Requests must come from the admin site");
  }
  const [section, token] = path;

  if (section === "login" && method === "POST") {
    const body = await readJson(request);
    const email = v.email(body.email);
    const user = await checkLogin(db, request, email, String(body.password ?? ""));
    return startSession(db, request, user);
  }

  if (section === "logout" && method === "POST") {
    const t = cookieValue(request);
    if (t) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(t)).run();
    return json({ ok: true }, 200, { "Set-Cookie": setCookie(request, "", 0) });
  }

  if (section === "setup") {
    if (!env.SETUP_CODE) throw new HttpError(503, "Setup isn't available: the SETUP_CODE secret isn't set");
    const hasOwner = await ownerExists(db);
    if (method === "GET") return json({ needed: !hasOwner });
    if (method === "POST") {
      const body = await readJson(request);
      const now = Date.now();
      const ip = clientIp(request);
      if (await ipBlocked(db, ip, now)) throw new HttpError(429, "Too many wrong tries from here. Try again in 15 minutes.");
      // Spaces or a line break picked up when pasting the code, here or into the secret prompt, don't count.
      if (!sameText(String(body.code ?? "").trim(), String(env.SETUP_CODE).trim())) {
        await recordFailure(db, ip, null, now);
        throw new HttpError(401, "That setup code isn't right");
      }
      const email = v.email(body.email);
      if (!hasOwner) {
        const user = await createUser(db, { email, name: v.text(body.name, "name", { max: 80 }), password: body.password, owner: true });
        return startSession(db, request, user, undefined, 201);
      }
      // The owner forgot their password: the setup code lets them set a new one.
      const owner = await db.prepare("SELECT * FROM users WHERE is_owner = 1 AND email = ?").bind(email).first();
      if (!owner) throw new HttpError(400, "Setup is already done. To reset the owner's password, use the owner's email.");
      checkNewPassword(body.password, email);
      await db.batch([
        db.prepare("UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?").bind(await hashPassword(body.password), owner.id),
        db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(owner.id),
      ]);
      return startSession(db, request, owner);
    }
  }

  if (section === "invite" && token) {
    const invite = await inviteFrom(db, token);
    if (method === "GET") {
      return json({ bar: invite.display_name || invite.venue_name, role: invite.role, expiresAt: invite.expires_at });
    }
    if (method === "POST") {
      const body = await readJson(request);
      const email = v.email(body.email);
      const existing = await db.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first();
      const user = existing
        ? await checkLogin(db, request, email, String(body.password ?? ""))
        : await createUser(db, { email, name: v.text(body.name, "name", { max: 80 }), password: body.password });
      // Used up, whatever happens next.
      const used = await db.prepare("DELETE FROM invites WHERE id = ?").bind(invite.id).run();
      if (used.meta.changes !== 1) throw new HttpError(409, "This invite link has just been used");
      await addToVenue(db, invite.venue_id, email, invite.role);
      return startSession(db, request, user, { ...meOf(user), venueId: invite.venue_id }, existing ? 200 : 201);
    }
  }

  if (section === "reset" && token) {
    const reset = await resetFrom(db, token);
    if (method === "GET") return json({ email: reset.email });
    if (method === "POST") {
      const body = await readJson(request);
      checkNewPassword(body.password, reset.email);
      const used = await db.prepare("DELETE FROM password_resets WHERE token_hash = ?").bind(reset.token_hash).run();
      if (used.meta.changes !== 1) throw new HttpError(409, "This reset link has just been used");
      await db.batch([
        db.prepare("UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?")
          .bind(await hashPassword(body.password), reset.user_id),
        // Signs out everywhere, in case someone else knew the old password.
        db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(reset.user_id),
        db.prepare("DELETE FROM password_resets WHERE user_id = ?").bind(reset.user_id),
      ]);
      const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(reset.user_id).first();
      return startSession(db, request, user);
    }
  }

  throw new HttpError(404, "Not found");
}

// ---------- signed-in routes, called from admin.js ----------

/** POST /api/admin/account/password: change your own password, signing out your other sessions. */
export async function changePassword(request, env, user) {
  const body = await readJson(request);
  if (!user.id) throw new HttpError(400, "The local test sign-in has no password to change");
  const fresh = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
  if (!(await verifyPassword(String(body.current ?? ""), fresh.password_hash))) {
    throw new HttpError(401, "Your current password isn't right");
  }
  checkNewPassword(body.password, fresh.email);
  const keep = await sha256(cookieValue(request) || "");
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(body.password), user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(user.id, keep),
  ]);
  return json({ ok: true });
}

/** A one-time link, valid for [days], that the caller passes on. */
export async function makeLink(request, path, days) {
  const token = randomToken();
  return { token, hash: await sha256(token), link: `${new URL(request.url).origin}/admin/#/${path}/${token}`, expiresAt: Date.now() + days * DAY };
}
