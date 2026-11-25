// Bingo on a bar's TVs: 75-ball, one game per bar. Any TV showing the Bingo channel can become the host;
// only the host calls numbers, starts a new game, takes back a call or sets what wins. The server draws the
// numbers, so every TV shows the same game.
//
// Each bar's game lives in its bingo room (bingoRoom.js), a Durable Object that also holds a WebSocket to
// each of the bar's TVs showing the board. The host sends its calls over that socket, and the room sends the
// result to every TV at once, with no database in the way. The HTTP routes here do the same through the room,
// for TVs whose socket is down and for older versions of the app.

import { HttpError, json, readJson } from "./http.js";
import { screenFromToken } from "./tv.js";

export const BALLS = 75;
export const ACTIONS = new Set(["host", "unhost", "call", "undo", "new", "pattern"]);
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

/** The game as one TV should show it: the same for every TV, except whether it's the host. */
export function forScreen(game, screenId) {
  const { hostScreenId, ...rest } = game;
  return { ...rest, host: hostScreenId !== null && hostScreenId === screenId };
}

/** The bar's bingo room. */
function room(env, venueId) {
  return env.BINGO_ROOMS.get(env.BINGO_ROOMS.idFromName(venueId));
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
  const game = await room(env, screen.venue_id).game(screen.venue_id);
  const state = forScreen(game, screen.id);
  // Whether this TV is the host differs per TV, so it's part of the ETag along with the version.
  const etag = `"${state.version}-${state.host ? 1 : 0}"`;
  const headers = { ETag: etag, "Cache-Control": "no-store" };
  if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
  return json(state, 200, headers);
}

/**
 * POST /api/tv/bingo/<action>: "host" makes this TV the host (taking over from any other) and "unhost" stops.
 * Only the host can "call" the next number, "undo" the last one, start a "new" game, or set the winning
 * "pattern" ({pattern}); a new game keeps the pattern. Calls, undos and new games can say which {version} of
 * the game they were made from; if the game has moved on since, as with a double press, nothing changes.
 */
export async function bingoAction(request, env, action) {
  if (!ACTIONS.has(action)) throw new HttpError(404, "Not found");
  const screen = await bingoScreen(request, env);
  const body = await readJson(request).catch(() => ({}));
  const result = await room(env, screen.venue_id).act(screen.venue_id, { id: screen.id, name: screen.name }, action, body ?? {});
  if (result.error) throw new HttpError(result.status, result.error);
  return json(forScreen(result.game, screen.id));
}

/**
 * GET /api/tv/bingo/live, as a WebSocket: the TV gets the game straight away, then every change the moment
 * it happens. The TV sends "ping" now and then and gets "pong" back, to know the connection is still there,
 * and the host sends its actions as {"action": "call", "version": 12} and so on.
 */
export async function liveBingo(request, env) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "Connect with a WebSocket");
  const screen = await bingoScreen(request, env);
  return room(env, screen.venue_id).fetch("https://bingo-room/live", {
    headers: {
      Upgrade: "websocket",
      "X-Venue-Id": screen.venue_id,
      "X-Screen-Id": screen.id,
      "X-Screen-Name": encodeURIComponent(screen.name),
    },
  });
}
