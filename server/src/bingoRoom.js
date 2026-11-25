// A bar's bingo room: a Durable Object that keeps the bar's bingo game and holds a WebSocket to each of the
// bar's TVs showing the Bingo channel. The host's calls come in over its socket and go straight out to every
// TV, so a number shows everywhere a moment after it's called.
//
// It uses the hibernation API, so a room with nothing happening costs nothing: Cloudflare keeps the sockets
// open and only wakes the room when a TV connects or sends something. "ping" is answered with "pong" without
// waking it. The game is kept in the room's own storage, so it survives the room going to sleep.

import { DurableObject } from "cloudflare:workers";
import { ACTIONS, PATTERNS, drawNumber, forScreen } from "./bingo.js";

/** Actions that a double press would repeat, so they say which version of the game they were made from. */
const GUARDED = new Set(["call", "undo", "new"]);

export class BingoRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    /** The game, once loaded from storage. */
    this.current = null;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /**
   * The game. The first time a room is used it takes over the bar's game from the database, where games were
   * kept before rooms had their own storage, so a game in progress carries on.
   */
  async game(venueId) {
    if (this.current) return this.current;
    let game = await this.ctx.storage.get("game");
    if (!game) {
      if (!venueId) throw new Error("This bingo room doesn't know its bar yet");
      const row = await this.env.DB.prepare("SELECT * FROM bingo_games WHERE venue_id = ?").bind(venueId).first();
      const host = row?.host_screen_id
        ? await this.env.DB.prepare("SELECT id, name FROM screens WHERE id = ? AND venue_id = ?").bind(row.host_screen_id, venueId).first()
        : null;
      game = {
        game: row?.game ?? 1,
        called: row ? JSON.parse(row.called) : [],
        hostScreenId: host?.id ?? null,
        hostName: host?.name ?? null,
        pattern: row?.pattern ?? "regular",
        version: row?.version ?? 1,
      };
      await this.ctx.storage.put("game", game);
    }
    this.current ??= game;
    return this.current;
  }

  /**
   * Does [action] for [screen] ({id, name}) and tells every TV. Returns {game}, or {error, status}. A guarded
   * action made from an older version than the game's changes nothing: it's a repeat of one already done.
   */
  async act(venueId, screen, action, body = {}) {
    if (!ACTIONS.has(action)) return { error: "Not found", status: 404 };
    const game = await this.game(venueId);
    if (GUARDED.has(action) && Number.isInteger(body.version) && body.version !== game.version) {
      return { game, repeat: true };
    }
    const isHost = game.hostScreenId === screen.id;
    const next = { ...game };
    if (action === "host") {
      next.hostScreenId = screen.id;
      next.hostName = screen.name;
    } else if (action === "unhost") {
      if (!isHost) return { game };
      next.hostScreenId = null;
      next.hostName = null;
    } else {
      if (!isHost) return { error: "Only the TV hosting bingo can do that", status: 403 };
      if (action === "call") {
        const n = drawNumber(game.called);
        if (n === null) return { error: "All 75 numbers have been called", status: 409 };
        next.called = [...game.called, n];
      } else if (action === "undo") {
        if (!game.called.length) return { game };
        next.called = game.called.slice(0, -1);
      } else if (action === "pattern") {
        if (!PATTERNS.includes(body.pattern)) return { error: `pattern must be one of ${PATTERNS.join(", ")}`, status: 400 };
        next.pattern = body.pattern;
      } else {
        next.called = [];
        next.game = game.game + 1;
      }
    }
    next.version = game.version + 1;
    this.current = next;
    // Nothing is sent until this is saved, so no TV sees a number the room could forget.
    await this.ctx.storage.put("game", next);
    this.broadcast(next);
    return { game: next };
  }

  /** A TV connecting. The worker has already checked who it is. */
  async fetch(request) {
    const screenId = request.headers.get("X-Screen-Id");
    const name = decodeURIComponent(request.headers.get("X-Screen-Name") ?? "").slice(0, 100);
    const game = await this.game(request.headers.get("X-Venue-Id"));
    const [client, server] = Object.values(new WebSocketPair());
    // The tags remember which screen this is, even across hibernation.
    this.ctx.acceptWebSocket(server, [screenId, name]);
    server.send(JSON.stringify(forScreen(game, screenId)));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Sends the game to every connected TV, each told whether it's the host. */
  broadcast(game) {
    for (const ws of this.ctx.getWebSockets()) {
      const [screenId] = this.ctx.getTags(ws);
      try {
        ws.send(JSON.stringify(forScreen(game, screenId)));
      } catch {
        // That TV has gone; Cloudflare closes the socket.
      }
    }
  }

  /** An action from a TV, like {"action": "call", "version": 12}. */
  async webSocketMessage(ws, message) {
    if (message === "ping") {
      ws.send("pong");
      return;
    }
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const [screenId, name] = this.ctx.getTags(ws);
    const result = await this.act(null, { id: screenId, name }, String(msg?.action), msg ?? {});
    if (result.error) ws.send(JSON.stringify({ error: result.error }));
    // A repeat changes nothing, but this TV may be behind, so it gets the game as it is.
    else if (result.repeat) ws.send(JSON.stringify(forScreen(result.game, screenId)));
  }

  webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "Bye");
    } catch {
      // Already closed.
    }
  }
}
