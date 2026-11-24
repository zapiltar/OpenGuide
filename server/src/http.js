/** An error with an HTTP status, turned into a JSON response by the router. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export async function readJson(request) {
  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Send JSON with Content-Type: application/json");
  }
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "The request body isn't valid JSON");
  }
}

const BASE64URL = { "+": "-", "/": "_", "=": "" };

export function randomToken(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, (c) => BASE64URL[c]);
}

export async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** The public URL of an uploaded image, or null. */
export function imageUrl(origin, key) {
  return key ? `${origin}/img/${key}` : null;
}
