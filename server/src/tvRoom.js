// A bar's TV room: a Durable Object holding a WebSocket to each of the bar's linked TVs that's switched on.
// When someone presses "Send changes to TVs" on the site, the room tells every connected TV to fetch its
// feed, so the TVs don't have to keep asking whether anything changed. It also knows which TVs are on right
// now, for the Screens page.
//
// It uses the hibernation API, so it costs nothing while it waits: Cloudflare keeps the sockets open and only
// wakes the room when a TV connects or the site sends something. "ping" is answered with "pong" without waking
// it. It stores nothing.

import { DurableObject } from "cloudflare:workers";

export class TvRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** A TV connecting. The worker has already checked who it is. */
  async fetch(request) {
    const screenId = request.headers.get("X-Screen-Id");
    const [client, server] = Object.values(new WebSocketPair());
    // The tag remembers which screen this is, even across hibernation.
    this.ctx.acceptWebSocket(server, [screenId]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Tells every connected TV, or just [screenId]'s, to fetch its feed now. Returns how many TVs were told. */
  refresh(screenId = null) {
    const sockets = screenId ? this.ctx.getWebSockets(screenId) : this.ctx.getWebSockets();
    const told = new Set();
    for (const ws of sockets) {
      try {
        ws.send("refresh");
        told.add(this.ctx.getTags(ws)[0]);
      } catch {
        // That TV has gone; Cloudflare closes the socket.
      }
    }
    return told.size;
  }

  /** The screens that are connected right now. */
  connected() {
    return [...new Set(this.ctx.getWebSockets().map((ws) => this.ctx.getTags(ws)[0]))];
  }

  webSocketMessage(ws, message) {
    // Only reached if a "ping" arrives some other way than the automatic answer.
    if (message === "ping") ws.send("pong");
  }

  webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "Bye");
    } catch {
      // Already closed.
    }
  }
}

/** The bar's TV room. */
export function tvRoom(env, venueId) {
  return env.TV_ROOMS.get(env.TV_ROOMS.idFromName(venueId));
}
