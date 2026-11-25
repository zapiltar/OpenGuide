import { handleAuth } from "./accounts.js";
import { handleAdmin } from "./admin.js";
import { HttpError, json } from "./http.js";
import { feed, pairingStatus, setLayout, startPairing, unlink } from "./tv.js";
import { tvWeather } from "./weather.js";
import { bingoAction, getBingo, liveBingo } from "./bingo.js";

export { BingoRoom } from "./bingoRoom.js";

// Uploaded image keys look like "<bar id>/<uuid>.<ext>".
const IMAGE_KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|webp|gif)$/;

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;

  if (path.startsWith("/api/auth/")) {
    return handleAuth(request, env, path.slice("/api/auth/".length).split("/"));
  }
  if (path.startsWith("/api/admin/")) {
    return handleAdmin(request, env, path.slice("/api/admin/".length).split("/"));
  }
  if (path === "/api/tv/pair" && method === "POST") return startPairing(request, env);
  if (path === "/api/tv/pair/status" && method === "POST") return pairingStatus(request, env);
  if (path === "/api/tv/feed" && method === "GET") return feed(request, env, ctx);
  if (path === "/api/tv/unlink" && method === "POST") return unlink(request, env);
  if (path === "/api/tv/layout" && method === "POST") return setLayout(request, env);
  if (path === "/api/tv/weather" && method === "GET") return tvWeather(request, env);
  if (path === "/api/tv/bingo" && method === "GET") return getBingo(request, env);
  if (path === "/api/tv/bingo/live" && method === "GET") return liveBingo(request, env);
  if (path.startsWith("/api/tv/bingo/") && method === "POST") return bingoAction(request, env, path.slice("/api/tv/bingo/".length));
  if (path.startsWith("/img/") && method === "GET") return image(path.slice(5), env);
  if (path.startsWith("/api/")) throw new HttpError(404, "Not found");
  return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
}

async function image(key, env) {
  if (!IMAGE_KEY.test(key)) return new Response("Not found", { status: 404 });
  const obj = await env.IMAGES.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("ETag", obj.httpEtag);
  // Keys are never reused, so TVs and browsers can keep images forever.
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(obj.body, { headers });
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Something went wrong on the server" }, 500);
    }
  },
};
