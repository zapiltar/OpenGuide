import { HttpError, imageUrl, json, menuSectionsOut, randomToken, readJson, sha256 } from "./http.js";
import { occurrences } from "./schedule.js";
import { LAYOUTS, channelOf } from "./validate.js";

// Linking a TV:
// 1. The TV calls POST /api/tv/pair and shows the returned code. It keeps the secret to itself.
// 2. Staff enter the code on the admin site, which creates the screen (see admin.js, claimScreen).
// 3. The TV polls POST /api/tv/pair/status with code and secret. Once claimed, it gets a screen token, once.
//    Only the token's hash is stored.
// After that the TV sends the token as "Authorization: Bearer ..." to GET /api/tv/feed.

const PAIR_TTL = 10 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // No 0/O, 1/I/L: easy to read off a TV across a room.
const DAY = 86_400_000;
// TVs check every couple of minutes. Recording each check would be most of the database's writes, so
// "last seen" is only updated when it's this old, or the app version changed.
const SEEN_EVERY = 4 * 60_000;
const SPECIAL_DAYS = 7;
const EVENT_DAYS = 60;
// A repeating event is sent as its next few dates, so it doesn't crowd one-time events off the TVs' lists.
const REPEAT_DAYS = 15;
const REPEAT_DATES = 2;

function newCode() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  const s = [...b].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

export function normalizeCode(code) {
  const s = String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 6 ? `${s.slice(0, 3)}-${s.slice(3)}` : null;
}

/** Removes expired pairings, and screens whose TV never finished linking. */
export async function cleanUpPairings(db, now) {
  await db.batch([
    db.prepare("DELETE FROM pairings WHERE expires_at < ?").bind(now),
    db.prepare(
      "DELETE FROM screens WHERE token_hash IS NULL AND id NOT IN (SELECT screen_id FROM pairings WHERE screen_id IS NOT NULL)",
    ),
  ]);
}

export async function startPairing(request, env) {
  const now = Date.now();
  await cleanUpPairings(env.DB, now);
  const secret = randomToken();
  const secretHash = await sha256(secret);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    const { meta } = await env.DB.prepare(
      "INSERT INTO pairings (code, secret_hash, expires_at) VALUES (?, ?, ?) ON CONFLICT(code) DO NOTHING",
    ).bind(code, secretHash, now + PAIR_TTL).run();
    if (meta.changes === 1) {
      return json({ code, secret, expiresAt: now + PAIR_TTL, pollSeconds: 3 }, 201);
    }
  }
  throw new HttpError(503, "Couldn't make a pairing code, try again");
}

export async function pairingStatus(request, env) {
  const body = await readJson(request);
  const code = normalizeCode(body.code);
  if (!code || typeof body.secret !== "string") throw new HttpError(400, "code and secret are required");
  const row = await env.DB.prepare("SELECT * FROM pairings WHERE code = ?").bind(code).first();
  if (!row || row.secret_hash !== (await sha256(body.secret))) {
    return json({ status: "unknown" }, 404);
  }
  if (row.expires_at < Date.now()) return json({ status: "expired" }, 410);
  if (!row.screen_id) return json({ status: "waiting" });

  const token = randomToken();
  const screen = await env.DB.prepare(
    "SELECT screens.id, screens.name, venues.name AS venue_name, venues.display_name FROM screens JOIN venues ON venues.id = screens.venue_id WHERE screens.id = ?",
  ).bind(row.screen_id).first();
  await env.DB.batch([
    env.DB.prepare("UPDATE screens SET token_hash = ? WHERE id = ?").bind(await sha256(token), row.screen_id),
    env.DB.prepare("DELETE FROM pairings WHERE code = ?").bind(code),
  ]);
  return json({
    status: "linked",
    token,
    screen: { id: screen.id, name: screen.name },
    venue: { name: screen.display_name || screen.venue_name },
  });
}

export async function screenFromToken(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "Missing screen token");
  const screen = await env.DB.prepare("SELECT * FROM screens WHERE token_hash = ?").bind(await sha256(token)).first();
  // 401 tells the app this TV has been unlinked, so it goes back to plain OpenGuide.
  if (!screen) throw new HttpError(401, "This screen isn't linked to a bar any more");
  return screen;
}

/**
 * The dates an event row stands for: itself, or a repeating event's next few dates from [day] on, within its
 * from and until dates. A repeat with no end time is sent with end null, like a one-time event.
 */
export function eventDates(e, timeZone, day) {
  if (!e.repeat) return [{ e, start: e.starts_at, end: e.ends_at }];
  const r = JSON.parse(e.repeat);
  // occurrences() needs an end; one minute stands in for "no end time" and is dropped again below.
  const endClock = r.end ?? (() => {
    const [h, m] = r.start.split(":").map(Number);
    const t = h * 60 + m + 1;
    return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  })();
  const from = Math.max(day, e.starts_at);
  const to = Math.min(day + REPEAT_DAYS * DAY, e.ends_at ?? Infinity);
  if (from >= to) return [];
  return occurrences({ type: "weekly", days: r.days, start: r.start, end: endClock }, timeZone, from, to)
    .filter((o) => o.start >= e.starts_at && (e.ends_at === null || o.start < e.ends_at))
    .slice(0, REPEAT_DATES)
    .map((o) => ({ e, start: o.start, end: r.end ? o.end : null }));
}

/** POST /api/tv/layout {layout}: the TV changed its picture layout from its own menu. */
export async function setLayout(request, env) {
  const screen = await screenFromToken(request, env);
  const body = await readJson(request);
  if (!LAYOUTS.includes(body.layout)) throw new HttpError(400, `layout must be one of ${LAYOUTS.join(", ")}`);
  await env.DB.batch([
    env.DB.prepare("UPDATE screens SET layout = ? WHERE id = ?").bind(body.layout, screen.id),
    env.DB.prepare("UPDATE venues SET feed_version = feed_version + 1 WHERE id = ?").bind(screen.venue_id),
  ]);
  return json({ layout: body.layout });
}

/** The TV unlinked itself from its own settings, so the screen goes from the bar's list too. */
export async function unlink(request, env) {
  const screen = await screenFromToken(request, env);
  await env.DB.prepare("DELETE FROM screens WHERE id = ?").bind(screen.id).run();
  return new Response(null, { status: 204 });
}

const forScreen = (row, screenId) => !row.screens || JSON.parse(row.screens).includes(screenId);

/**
 * Everything a linked TV shows. The ETag combines the bar's feed version with the UTC day, because the
 * window of special occurrences moves forward each day even when nothing was edited.
 */
export async function feed(request, env, ctx) {
  const screen = await screenFromToken(request, env);
  const now = Date.now();
  const appVersion = (request.headers.get("X-App-Version") || "").slice(0, 32) || null;
  if (!screen.last_seen || now - screen.last_seen >= SEEN_EVERY || (appVersion && appVersion !== screen.app_version)) {
    ctx.waitUntil(
      env.DB.prepare("UPDATE screens SET last_seen = ?, app_version = COALESCE(?, app_version) WHERE id = ?")
        .bind(now, appVersion, screen.id).run(),
    );
  }

  const venue = await env.DB.prepare("SELECT * FROM venues WHERE id = ?").bind(screen.venue_id).first();
  const day = Math.floor(now / DAY) * DAY;
  const etag = `"${venue.feed_version}-${day / DAY}"`;
  const headers = { ETag: etag, "X-Server-Time": String(now) };
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers: { ...headers, "Cache-Control": "no-store" } });
  }

  const origin = new URL(request.url).origin;
  const [menus, events, specials] = await Promise.all([
    env.DB.prepare("SELECT * FROM menus WHERE venue_id = ? ORDER BY sort, title").bind(venue.id).all(),
    env.DB.prepare(
      `SELECT * FROM events WHERE venue_id = ? AND starts_at < ? AND (
         (repeat IS NULL AND COALESCE(ends_at, starts_at) >= ?) OR (repeat IS NOT NULL AND (ends_at IS NULL OR ends_at > ?))
       ) ORDER BY starts_at LIMIT 100`,
    ).bind(venue.id, day + EVENT_DAYS * DAY, day, day).all(),
    env.DB.prepare("SELECT * FROM specials WHERE venue_id = ? AND enabled = 1").bind(venue.id).all(),
  ]);

  const body = {
    version: venue.feed_version,
    serverTime: now,
    venue: {
      name: venue.display_name || venue.name,
      logo: imageUrl(origin, venue.logo_key),
      timezone: venue.timezone,
      theme: venue.theme_primary ? { primary: venue.theme_primary, secondary: venue.theme_secondary } : null,
      channel: channelOf(venue.channel),
      bingo: venue.bingo !== 0,
    },
    screen: { id: screen.id, name: screen.name, layout: screen.layout },
    menus: menus.results.filter((m) => forScreen(m, screen.id)).map((m) => ({
      id: m.id,
      title: m.title,
      kind: m.kind,
      image: imageUrl(origin, m.image_key),
      // The TV only needs each item picture's address.
      sections: menuSectionsOut(m.sections, origin)?.map((sec) => ({
        ...sec,
        items: sec.items.map(({ imageUrl: url, ...it }) => ({ ...it, image: url })),
      })) ?? null,
    })),
    events: events.results
      .filter((e) => forScreen(e, screen.id))
      .flatMap((e) => eventDates(e, venue.timezone, day))
      .map(({ e, start, end }) => ({
        id: e.repeat ? `${e.id}@${start}` : e.id,
        title: e.title,
        description: e.description,
        image: imageUrl(origin, e.image_key),
        fullScreen: e.picture_only === 1,
        start,
        end,
      }))
      .sort((a, b) => a.start - b.start),
    specials: specials.results
      .filter((s) => forScreen(s, screen.id))
      .map((s) => ({
        id: s.id,
        title: s.title,
        text: s.text,
        image: imageUrl(origin, s.image_key),
        display: s.picture_only ? "picture" : s.display,
        timeoutSeconds: s.timeout_seconds,
        repeatMinutes: s.repeat_minutes,
        occurrences: occurrences(JSON.parse(s.schedule), venue.timezone, day - DAY, day + (SPECIAL_DAYS + 1) * DAY),
      }))
      .filter((s) => s.occurrences.length > 0),
  };
  return json(body, 200, headers);
}
