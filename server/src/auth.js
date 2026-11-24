import { HttpError } from "./http.js";

// Staff sign in through Cloudflare Access, which puts a signed JWT on every request it lets through
// (the Cf-Access-Jwt-Assertion header). The Worker checks that token's signature, audience, issuer and expiry
// itself, so a request that reaches the Worker some other way can't pretend to be signed in.

const CERTS_TTL = 60 * 60 * 1000;
let certsCache = null; // { url, keys: Map<kid, CryptoKey>, fetchedAt }

function b64urlDecode(s) {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const decodeJson = (s) => JSON.parse(new TextDecoder().decode(b64urlDecode(s)));

async function accessKeys(teamDomain, forceRefresh) {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  if (!forceRefresh && certsCache && certsCache.url === url && Date.now() - certsCache.fetchedAt < CERTS_TTL) {
    return certsCache.keys;
  }
  const res = await fetch(url);
  if (!res.ok) throw new HttpError(503, "Couldn't reach Cloudflare Access to check your sign-in");
  const { keys } = await res.json();
  const map = new Map();
  for (const jwk of keys) {
    if (jwk.kty !== "RSA") continue;
    map.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  certsCache = { url, keys: map, fetchedAt: Date.now() };
  return map;
}

/** Returns the verified token's payload, or throws 401. */
export async function verifyAccessJwt(token, teamDomain, audience, now = Date.now()) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "Sign-in token is malformed");
  let header, payload;
  try {
    header = decodeJson(parts[0]);
    payload = decodeJson(parts[1]);
  } catch {
    throw new HttpError(401, "Sign-in token is malformed");
  }
  if (header.alg !== "RS256") throw new HttpError(401, "Sign-in token uses an unexpected algorithm");
  let keys = await accessKeys(teamDomain, false);
  if (!keys.has(header.kid)) keys = await accessKeys(teamDomain, true); // Access rotates its keys.
  const key = keys.get(header.kid);
  if (!key) throw new HttpError(401, "Sign-in token was signed by an unknown key");
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), signed);
  if (!ok) throw new HttpError(401, "Sign-in token signature is invalid");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(audience)) throw new HttpError(401, "Sign-in token is for a different application");
  if (payload.iss !== `https://${teamDomain}`) throw new HttpError(401, "Sign-in token has the wrong issuer");
  const seconds = now / 1000;
  if (typeof payload.exp !== "number" || payload.exp < seconds) throw new HttpError(401, "Your sign-in has expired");
  if (typeof payload.nbf === "number" && payload.nbf > seconds + 60) throw new HttpError(401, "Sign-in token isn't valid yet");
  if (typeof payload.email !== "string" || !payload.email) throw new HttpError(401, "Sign-in token has no email");
  return payload;
}

function isLocalhost(url) {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function owners(env) {
  return new Set((env.OWNER_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
}

/**
 * Who is making this admin request: { email, owner }.
 * DEV_ADMIN_EMAIL (from .dev.vars) is honoured only on localhost, so it can't open up a deployed Worker
 * even if it were set there by mistake.
 */
export async function identify(request, env) {
  let email;
  if (env.DEV_ADMIN_EMAIL && isLocalhost(request.url)) {
    email = env.DEV_ADMIN_EMAIL;
  } else {
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
      throw new HttpError(503, "Sign-in isn't set up yet: ACCESS_TEAM_DOMAIN and ACCESS_AUD are missing");
    }
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) throw new HttpError(401, "Sign in through Cloudflare Access first");
    email = (await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD)).email;
  }
  email = email.trim().toLowerCase();
  return { email, owner: owners(env).has(email) };
}

export function requireOwner(user) {
  if (!user.owner) throw new HttpError(403, "Only the site owner can do that");
}

/** Throws 404 unless [user] may manage [venueId]. 404 rather than 403, so bar ids can't be probed. */
export async function requireVenue(db, user, venueId) {
  const venue = await db.prepare("SELECT * FROM venues WHERE id = ?").bind(venueId).first();
  if (!venue) throw new HttpError(404, "No such bar");
  if (user.owner) return venue;
  const row = await db.prepare("SELECT 1 FROM staff WHERE venue_id = ? AND email = ?").bind(venueId, user.email).first();
  if (!row) throw new HttpError(404, "No such bar");
  return venue;
}

/**
 * Blocks cross-site form posts: writes must be JSON (or an image upload), and if the browser says where
 * the request came from, it must be this site.
 */
export function checkSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, "Requests must come from the admin site");
}
