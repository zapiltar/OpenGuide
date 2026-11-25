// Bingo on a bar's TVs: 75-ball, one game per bar. Any TV showing the Bingo channel can become the host;
// only the host calls numbers, starts a new game or takes back a call. The server draws the numbers, so
// every TV shows the same game. TVs showing the board keep a WebSocket open to the bar's bingo room
// (bingoRoom.js), which sends each change as it happens; GET /api/tv/bingo is there for catching up.

import { HttpError, json, readJson } from "./http.js";
import { screenFromToken } from "./tv.js";

export const BALLS = 75;
const ACTIONS = new Set(["host", "unhost", "call", "undo", "new", "pattern"]);
/** What wins: any line, a Z, an X, the outside edge, or every number on the card. */
export const PATTERNS = ["regular", "z", "x", "box", "coverall"];

/** A random number from 1 to 75 that hasn't been called yet, or null when all have been. */
export function drawNumber(called) {
  const seen = new Set(called);
  const left = [];
  for (let n = 1; n <= BALLS; n++) if (!seen.has(n)) left.push(n);
  if (!left.length) return null;
  // Rejection sampling keeps every number equally likely.
  const limit = Math.floor(0x1_0000_0000 / left.length) * left.length;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return left[buf[0] % left.length];
}

async function load(env, venueId) {
  const row = await env.DB.prepare("SELECT * FROM bingo_games WHERE venue_id = ?").bind(venueId).first();
  if (row) return row;
  await env.DB.prepare("INSERT OR IGNORE INTO bingo_games (venue_id, updated_at) VALUES (?, ?)").bind(venueId, Date.now()).run();
  return env.DB.prepare("SELECT * FROM bingo_games WHERE venue_id = ?").bind(venueId).first();
}

/** The game as every TV sees it, with which screen is hosting. */
async function snapshot(env, row) {
  const host = row.host_screen_id
    ? await env.DB.prepare("SELECT id, name FROM screens WHERE id = ? AND venue_id = ?").bind(row.host_screen_id, row.venue_id).first()
    : null;
  return {
    game: row.game,
    called: JSON.parse(row.called),
    hostScreenId: host?.id ?? null,
    hostName: host?.name ?? null,
    pattern: row.pattern ?? "regular",
    version: row.version,
  };
}

/** The game as one TV should show it: the same for every TV, except whether it's the host. */
export function forScreen(snap, screenId) {
  const { hostScreenId, ...rest } = snap;
  return { ...rest, host: hostScreenId !== null && hostScreenId === screenId };
}

async function stateFor(env, row, screen) {
  return forScreen(await snapshot(env, row), screen.id);
}

/** The bar's bingo room, which holds the live connections of its TVs showing the board. */
function room(env, venueId) {
  return env.BINGO_ROOMS.get(env.BINGO_ROOMS.idFromName(venueId));
}

/**
 * GET /api/tv/bingo/live, as a WebSocket: the TV gets the game straight away, then every change the moment
 * it happens. The TV sends "ping" now and then and gets "pong" back, to know the connection is still there.
 */
export async function liveBingo(request, env) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "Connect with a WebSocket");
  const screen = await bingoScreen(request, env);
  const snap = await snapshot(env, await load(env, screen.venue_id));
  return room(env, screen.venue_id).fetch("https://bingo-room/live", {
    headers: { Upgrade: "websocket", "X-Screen-Id": screen.id, "X-Bingo-State": JSON.stringify(snap) },
  });
}

async function bingoScreen(request, env) {
  const screen = await screenFromToken(request, env);
  const venue = await env.DB.prepare("SELECT bingo FROM venues WHERE id = ?").bind(screen.venue_id).first();
  if (!venue?.bingo) throw new HttpError(403, "Bingo is turned off for this bar");
  return screen;
}

/** GET /api/tv/bingo: the game as this TV should show it. */
export async function getBingo(request, env) {
  const screen = await bingoScreen(request, env);
  const row = await load(env, screen.venue_id);
  // Whether this TV is the host differs per TV, so it's part of the ETag along with the version.
  const etag = `"${row.version}-${row.host_screen_id === screen.id ? 1 : 0}"`;
  const headers = { ETag: etag, "Cache-Control": "no-store" };
  if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
  return json(await stateFor(env, row, screen), 200, headers);
}

/**
 * POST /api/tv/bingo/<action>: "host" makes this TV the host (taking over from any other) and "unhost" stops.
 * Only the host can "call" the next number, "undo" the last one, start a "new" game, or set the winning
 * "pattern" ({pattern}); a new game keeps the pattern. A change only applies
 * to the version it was worked out from, so two quick presses can't both draw from the same board.
 */
export async function bingoAction(request, env, action) {
  if (!ACTIONS.has(action)) throw new HttpError(404, "Not found");
  const screen = await bingoScreen(request, env);
  let wanted = null;
  if (action === "pattern") {
    wanted = (await readJson(request)).pattern;
    if (!PATTERNS.includes(wanted)) throw new HttpError(400, `pattern must be one of ${PATTERNS.join(", ")}`);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await load(env, screen.venue_id);
    const called = JSON.parse(row.called);
    const isHost = row.host_screen_id === screen.id;
    let host = row.host_screen_id;
    let nextCalled = called;
    let game = row.game;
    let pattern = row.pattern ?? "regular";
    if (action === "host") {
      host = screen.id;
    } else if (action === "unhost") {
      if (!isHost) return json(await stateFor(env, row, screen));
      host = null;
    } else {
      if (!isHost) throw new HttpError(403, "Only the TV hosting bingo can do that");
      if (action === "call") {
        const n = drawNumber(called);
        if (n === null) throw new HttpError(409, "All 75 numbers have been called");
        nextCalled = [...called, n];
      } else if (action === "undo") {
        if (!called.length) return json(await stateFor(env, row, screen));
        nextCalled = called.slice(0, -1);
      } else if (action === "pattern") {
        pattern = wanted;
      } else {
        nextCalled = [];
        game++;
      }
    }
    const result = await env.DB.prepare(
      "UPDATE bingo_games SET called = ?, game = ?, host_screen_id = ?, pattern = ?, version = version + 1, updated_at = ? WHERE venue_id = ? AND version = ?",
    ).bind(JSON.stringify(nextCalled), game, host, pattern, Date.now(), screen.venue_id, row.version).run();
    if (result.meta.changes === 1) {
      const snap = await snapshot(env, await load(env, screen.venue_id));
      // Tell every TV showing the board. If that fails, they still catch up when they reconnect.
      try {
        await room(env, screen.venue_id).broadcast(snap);
      } catch (e) {
        console.error("Bingo broadcast failed", e);
      }
      return json(forScreen(snap, screen.id));
    }
  }
  throw new HttpError(409, "The game changed at the same moment. Try again.");
}
