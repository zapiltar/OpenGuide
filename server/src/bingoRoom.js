// A bar's bingo room: a Durable Object holding the WebSockets of the bar's TVs that are showing the Bingo
// channel, so a called number reaches all of them at once instead of each TV asking every few seconds.
//
// It uses the hibernation API, so a room with nothing happening costs nothing: Cloudflare keeps the sockets
// open and only wakes the room when a TV connects or the game changes. "ping" is answered with "pong" without
// waking it. The game itself lives in D1; the room only passes it on.

import { DurableObject } from "cloudflare:workers";
import { forScreen } from "./bingo.js";

export class BingoRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    /** The newest game this room has sent, while it's awake, so a TV connecting mid-change isn't left behind. */
    this.latest = null;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** A TV connecting. The worker has already checked who it is and sends the game as it was a moment ago. */
  async fetch(request) {
    const screenId = request.headers.get("X-Screen-Id");
    let snap = JSON.parse(request.headers.get("X-Bingo-State"));
    if (this.latest && this.latest.version > snap.version) snap = this.latest;
    const [client, server] = Object.values(new WebSocketPair());
    // The tag remembers which screen this is, even across hibernation.
    this.ctx.acceptWebSocket(server, [screenId]);
    server.send(JSON.stringify(forScreen(snap, screenId)));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Sends a changed game to every connected TV, each told whether it's the host. */
  broadcast(snap) {
    if (this.latest && this.latest.version > snap.version) return;
    this.latest = snap;
    for (const ws of this.ctx.getWebSockets()) {
      const [screenId] = this.ctx.getTags(ws);
      try {
        ws.send(JSON.stringify(forScreen(snap, screenId)));
      } catch {
        // That TV has gone; Cloudflare closes the socket.
      }
    }
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
