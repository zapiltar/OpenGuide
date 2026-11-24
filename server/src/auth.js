import { sessionUser } from "./accounts.js";
import { HttpError } from "./http.js";

// Who is making an admin request, and what they may do.
// - The owner (the super user, made on the setup page) sees and manages every bar.
// - A bar's manager manages that bar's content and its people.
// - A bar's staff manage that bar's content.
// Accounts and sign-in are in accounts.js.

function isLocalhost(url) {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function owners(env) {
  return new Set((env.OWNER_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
}

/**
 * The signed-in user: { id, email, name, owner }. Throws 401 if nobody is signed in.
 * DEV_ADMIN_EMAIL (in .dev.vars, for tests and local work) signs every request in as that email, and is only
 * honoured on localhost, so it can't open up a deployed Worker even if it were set there by mistake.
 */
export async function identify(request, env) {
  if (env.DEV_ADMIN_EMAIL && isLocalhost(request.url)) {
    const email = env.DEV_ADMIN_EMAIL.trim().toLowerCase();
    return { id: null, email, name: null, owner: owners(env).has(email) };
  }
  const user = await sessionUser(request, env);
  if (!user) throw new HttpError(401, "Please sign in");
  return { id: user.id, email: user.email, name: user.name, owner: user.is_owner === 1 };
}

export function requireOwner(user) {
  if (!user.owner) throw new HttpError(403, "Only the site owner can do that");
}

/**
 * The bar, if [user] may manage it, with their role there ("owner", "manager" or "staff") as venue.role.
 * Throws 404 otherwise, rather than 403, so bar ids can't be probed.
 */
export async function requireVenue(db, user, venueId) {
  const venue = await db.prepare("SELECT * FROM venues WHERE id = ?").bind(venueId).first();
  if (!venue) throw new HttpError(404, "No such bar");
  if (user.owner) return { ...venue, role: "owner" };
  const row = await db.prepare("SELECT role FROM staff WHERE venue_id = ? AND email = ?").bind(venueId, user.email).first();
  if (!row) throw new HttpError(404, "No such bar");
  return { ...venue, role: row.role };
}

export function requireManager(venue) {
  if (venue.role !== "owner" && venue.role !== "manager") {
    throw new HttpError(403, "Only the bar's manager or the site owner can do that");
  }
}

/**
 * Blocks cross-site form posts: writes must be JSON (or an image upload), and if the browser says where
 * the request came from, it must be this site.
 */
export function checkSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, "Requests must come from the admin site");
}
