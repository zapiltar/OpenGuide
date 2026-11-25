import { INVITE_DAYS, RESET_DAYS, changePassword, makeLink } from "./accounts.js";
import { checkSameOrigin, identify, requireManager, requireOwner, requireVenue } from "./auth.js";
import { HttpError, imageUrl, json, menuSectionsOut, readJson } from "./http.js";
import { cleanUpPairings, normalizeCode } from "./tv.js";
import * as v from "./validate.js";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const PAIR_CLAIM_TTL = 10 * 60 * 1000;

const bump = (db, venueId) => db.prepare("UPDATE venues SET feed_version = feed_version + 1 WHERE id = ?").bind(venueId);

function venueOut(row, origin) {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    logo: row.logo_key,
    logoUrl: imageUrl(origin, row.logo_key),
    timezone: row.timezone,
    theme: row.theme_primary ? { primary: row.theme_primary, secondary: row.theme_secondary } : null,
    // What the signed-in person is at this bar: "owner", "manager" or "staff".
    role: row.role,
    channel: v.channelOf(row.channel),
    feedVersion: row.feed_version,
    createdAt: row.created_at,
  };
}

async function screenIds(db, venueId) {
  const { results } = await db.prepare("SELECT id FROM screens WHERE venue_id = ?").bind(venueId).all();
  return results.map((r) => r.id);
}

// Menus, events and specials share one set of routes. Each kind says how to check its input and how to
// turn a row into JSON.
const KINDS = {
  menus: {
    table: "menus",
    order: "sort, title",
    columns: ["title", "kind", "image_key", "sections", "sort", "screens"],
    parse(body, venueId, screens) {
      const kind = v.oneOf(body.kind, "kind", ["image", "list"]);
      const image = v.imageKey(body.image, venueId);
      if (kind === "image" && !image) throw new HttpError(400, "An image menu needs an image");
      return {
        title: v.text(body.title, "title", { max: 100, required: true }),
        kind,
        image_key: image,
        sections: kind === "list" ? JSON.stringify(v.menuSections(body.sections, venueId)) : null,
        sort: v.integer(body.sort ?? 0, "sort", { min: -1000, max: 1000 }),
        screens: jsonOrNull(v.screenList(body.screens, screens)),
      };
    },
    out: (r, origin) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      image: r.image_key,
      imageUrl: imageUrl(origin, r.image_key),
      sections: menuSectionsOut(r.sections, origin),
      sort: r.sort,
      screens: r.screens ? JSON.parse(r.screens) : null,
      updatedAt: r.updated_at,
    }),
  },
  events: {
    table: "events",
    order: "starts_at",
    columns: ["title", "description", "image_key", "picture_only", "starts_at", "ends_at", "repeat", "screens"],
    parse(body, venueId, screens, venue) {
      const image = v.imageKey(body.image, venueId);
      if (body.fullScreen !== undefined && typeof body.fullScreen !== "boolean") throw new HttpError(400, "fullScreen must be true or false");
      if (body.fullScreen && !image) throw new HttpError(400, "Upload a picture to show it full screen");
      const common = {
        title: v.text(body.title, "title", { max: 100, required: true }),
        description: v.text(body.description, "description", { max: 1000 }),
        image_key: image,
        picture_only: body.fullScreen ? 1 : 0,
        screens: jsonOrNull(v.screenList(body.screens, screens)),
      };
      if (body.repeat) {
        const r = v.eventRepeat(body.repeat, venue.timezone);
        return { ...common, starts_at: r.startsAt, ends_at: r.endsAt, repeat: JSON.stringify(r.repeat) };
      }
      const start = v.time(body.start, "start");
      const end = v.time(body.end, "end", { nullable: true });
      if (end !== null && end <= start) throw new HttpError(400, "end must be after start");
      return { ...common, starts_at: start, ends_at: end, repeat: null };
    },
    out: (r, origin) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      image: r.image_key,
      imageUrl: imageUrl(origin, r.image_key),
      fullScreen: r.picture_only === 1,
      start: r.starts_at,
      end: r.ends_at,
      repeat: r.repeat ? JSON.parse(r.repeat) : null,
      screens: r.screens ? JSON.parse(r.screens) : null,
      updatedAt: r.updated_at,
    }),
  },
  specials: {
    table: "specials",
    order: "title",
    columns: ["title", "text", "image_key", "schedule", "display", "picture_only", "timeout_seconds", "repeat_minutes", "enabled", "screens"],
    parse(body, venueId, screens) {
      // "picture" is a takeover showing only the uploaded image.
      const display = v.oneOf(body.display, "display", ["banner", "takeover", "picture"], "banner");
      const image = v.imageKey(body.image, venueId);
      if (display === "picture" && !image) throw new HttpError(400, "A full-screen picture special needs a picture");
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
        throw new HttpError(400, "enabled must be true or false");
      }
      return {
        title: v.text(body.title, "title", { max: 100, required: true }),
        text: v.text(body.text, "text", { max: 300 }),
        image_key: image,
        schedule: JSON.stringify(v.schedule(body.schedule)),
        display: display === "picture" ? "takeover" : display,
        picture_only: display === "picture" ? 1 : 0,
        timeout_seconds: v.timeoutSeconds(body.timeoutSeconds, display),
        repeat_minutes: v.integer(body.repeatMinutes, "repeatMinutes", { min: 1, max: 1440, nullable: true }),
        enabled: body.enabled === false ? 0 : 1,
        screens: jsonOrNull(v.screenList(body.screens, screens)),
      };
    },
    out: (r, origin) => ({
      id: r.id,
      title: r.title,
      text: r.text,
      image: r.image_key,
      imageUrl: imageUrl(origin, r.image_key),
      schedule: JSON.parse(r.schedule),
      display: r.picture_only ? "picture" : r.display,
      timeoutSeconds: r.timeout_seconds,
      repeatMinutes: r.repeat_minutes,
      enabled: r.enabled === 1,
      screens: r.screens ? JSON.parse(r.screens) : null,
      updatedAt: r.updated_at,
    }),
  },
};

const jsonOrNull = (x) => (x === null ? null : JSON.stringify(x));

/** Routes under /api/admin. [path] is the part after that prefix, split on "/". */
export async function handleAdmin(request, env, path) {
  const user = await identify(request, env);
  const method = request.method;
  if (method !== "GET") checkSameOrigin(request);
  const origin = new URL(request.url).origin;
  const db = env.DB;
  const [section, venueId, sub, itemId, extra] = path;

  if (section === "me" && path.length === 1 && method === "GET") {
    return json({ email: user.email, name: user.name, owner: user.owner });
  }
  if (section === "account" && venueId === "password" && method === "POST") return changePassword(request, env, user);
  if (section !== "venues") throw new HttpError(404, "Not found");

  // /venues
  if (venueId === undefined) {
    if (method === "GET") {
      const { results } = user.owner
        ? await db.prepare("SELECT *, 'owner' AS role FROM venues ORDER BY name").all()
        : await db.prepare("SELECT venues.*, staff.role FROM venues JOIN staff ON staff.venue_id = venues.id WHERE staff.email = ? ORDER BY name")
          .bind(user.email).all();
      return json(results.map((r) => venueOut(r, origin)));
    }
    if (method === "POST") {
      requireOwner(user);
      const body = await readJson(request);
      const row = {
        id: crypto.randomUUID(),
        name: v.text(body.name, "name", { max: 100, required: true }),
        display_name: v.text(body.displayName, "displayName", { max: 60 }),
        timezone: v.timeZone(body.timezone),
        created_at: Date.now(),
      };
      await db.prepare("INSERT INTO venues (id, name, display_name, timezone, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(row.id, row.name, row.display_name, row.timezone, row.created_at).run();
      return json(venueOut({ ...row, logo_key: null, feed_version: 1, role: "owner" }, origin), 201);
    }
    throw new HttpError(405, "Method not allowed");
  }

  const venue = await requireVenue(db, user, venueId);

  // /venues/:id
  if (sub === undefined) {
    if (method === "GET") return json(venueOut(venue, origin));
    if (method === "PATCH") {
      const body = await readJson(request);
      const next = { ...venue };
      if ("name" in body) {
        requireOwner(user);
        next.name = v.text(body.name, "name", { max: 100, required: true });
      }
      if ("displayName" in body) next.display_name = v.text(body.displayName, "displayName", { max: 60 });
      if ("logo" in body) next.logo_key = v.imageKey(body.logo, venueId, "logo");
      if ("timezone" in body) next.timezone = v.timeZone(body.timezone);
      if ("channel" in body) {
        const { results } = await db.prepare("SELECT id FROM menus WHERE venue_id = ?").bind(venueId).all();
        next.channel = JSON.stringify(v.channel(body.channel, v.channelOf(venue.channel), results.map((r) => r.id)));
      }
      if ("theme" in body) {
        const t = v.theme(body.theme);
        next.theme_primary = t?.primary ?? null;
        next.theme_secondary = t?.secondary ?? null;
      }
      await db.batch([
        db.prepare("UPDATE venues SET name = ?, display_name = ?, logo_key = ?, timezone = ?, theme_primary = ?, theme_secondary = ?, channel = ? WHERE id = ?")
          .bind(next.name, next.display_name, next.logo_key, next.timezone, next.theme_primary, next.theme_secondary, next.channel ?? null, venueId),
        bump(db, venueId),
      ]);
      return json(venueOut({ ...next, feed_version: venue.feed_version + 1 }, origin));
    }
    if (method === "DELETE") {
      requireOwner(user);
      await db.prepare("DELETE FROM venues WHERE id = ?").bind(venueId).run();
      await deleteImagesWithPrefix(env.IMAGES, `${venueId}/`);
      return new Response(null, { status: 204 });
    }
    throw new HttpError(405, "Method not allowed");
  }

  // /venues/:id/staff and /venues/:id/invites: the bar's people. The owner and the bar's manager only.
  if (sub === "staff" || sub === "invites") {
    requireManager(venue);
    const isOwner = venue.role === "owner";
    if (sub === "staff" && itemId === undefined && method === "GET") {
      const [members, invites] = await Promise.all([
        db.prepare(
          "SELECT staff.email, staff.role, staff.added_at, users.name, users.id AS user_id FROM staff LEFT JOIN users ON users.email = staff.email WHERE venue_id = ? ORDER BY staff.role, staff.email",
        ).bind(venueId).all(),
        db.prepare("SELECT id, role, created_by, created_at, expires_at FROM invites WHERE venue_id = ? AND expires_at > ? ORDER BY created_at DESC")
          .bind(venueId, Date.now()).all(),
      ]);
      return json({
        members: members.results.map((r) => ({ email: r.email, name: r.name, role: r.role, hasAccount: r.user_id !== null, addedAt: r.added_at })),
        invites: invites.results.map((r) => ({ id: r.id, role: r.role, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at })),
      });
    }
    if (sub === "invites" && itemId === undefined && method === "POST") {
      const role = v.oneOf((await readJson(request)).role, "role", ["manager", "staff"], "staff");
      if (role === "manager" && !isOwner) throw new HttpError(403, "Only the site owner can invite managers");
      const l = await makeLink(request, "join", INVITE_DAYS);
      const id = crypto.randomUUID();
      await db.prepare("INSERT INTO invites (id, token_hash, venue_id, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(id, l.hash, venueId, role, user.email, Date.now(), l.expiresAt).run();
      return json({ id, role, link: l.link, expiresAt: l.expiresAt }, 201);
    }
    if (sub === "invites" && itemId !== undefined && method === "DELETE") {
      await db.prepare("DELETE FROM invites WHERE id = ? AND venue_id = ?").bind(itemId, venueId).run();
      return new Response(null, { status: 204 });
    }
    if (sub === "staff" && itemId !== undefined) {
      const email = decodeURIComponent(itemId).toLowerCase();
      const member = await db.prepare("SELECT * FROM staff WHERE venue_id = ? AND email = ?").bind(venueId, email).first();
      if (!member) throw new HttpError(404, "That person isn't at this bar");
      if (!isOwner && member.role === "manager") throw new HttpError(403, "Only the site owner can change a manager's access");
      if (method === "DELETE") {
        await db.prepare("DELETE FROM staff WHERE venue_id = ? AND email = ?").bind(venueId, email).run();
        return new Response(null, { status: 204 });
      }
      // POST /venues/:id/staff/:email/reset: a one-time link to set a new password.
      if (method === "POST" && extra === "reset") {
        const target = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
        if (!target) throw new HttpError(404, "That person hasn't made an account yet");
        if (target.is_owner) throw new HttpError(403, "The owner resets their own password with the setup code");
        const l = await makeLink(request, "reset", RESET_DAYS);
        await db.prepare("INSERT INTO password_resets (token_hash, user_id, created_by, expires_at) VALUES (?, ?, ?, ?)")
          .bind(l.hash, target.id, user.email, l.expiresAt).run();
        return json({ link: l.link, expiresAt: l.expiresAt }, 201);
      }
    }
    throw new HttpError(405, "Method not allowed");
  }

  // /venues/:id/screens
  if (sub === "screens") {
    if (itemId === undefined && method === "GET") {
      const { results } = await db.prepare("SELECT * FROM screens WHERE venue_id = ? ORDER BY name").bind(venueId).all();
      return json(results.map((r) => ({
        id: r.id,
        name: r.name,
        layout: r.layout,
        linked: r.token_hash !== null,
        lastSeen: r.last_seen,
        appVersion: r.app_version,
        createdAt: r.created_at,
      })));
    }
    if (itemId === undefined && method === "POST") return claimScreen(request, db, venueId);
    if (itemId !== undefined) {
      const screen = await db.prepare("SELECT * FROM screens WHERE id = ? AND venue_id = ?").bind(itemId, venueId).first();
      if (!screen) throw new HttpError(404, "No such screen");
      if (method === "PATCH") {
        const body = await readJson(request);
        const name = "name" in body ? v.text(body.name, "name", { max: 60, required: true }) : screen.name;
        const layout = "layout" in body ? v.oneOf(body.layout, "layout", v.LAYOUTS) : screen.layout;
        await db.batch([
          db.prepare("UPDATE screens SET name = ?, layout = ? WHERE id = ?").bind(name, layout, itemId),
          bump(db, venueId),
        ]);
        return json({ id: itemId, name, layout });
      }
      if (method === "DELETE") {
        // Its token stops working at once; the TV sees a 401 on its next check and unlinks itself.
        await db.prepare("DELETE FROM screens WHERE id = ?").bind(itemId).run();
        return new Response(null, { status: 204 });
      }
    }
    throw new HttpError(405, "Method not allowed");
  }

  // /venues/:id/images
  if (sub === "images" && itemId === undefined && method === "POST") {
    return uploadImage(request, env, venueId, origin);
  }

  // /venues/:id/{menus,events,specials}[/:itemId]
  const kind = KINDS[sub];
  if (!kind || extra !== undefined) throw new HttpError(404, "Not found");
  const { table } = kind;
  if (itemId === undefined) {
    if (method === "GET") {
      const { results } = await db.prepare(`SELECT * FROM ${table} WHERE venue_id = ? ORDER BY ${kind.order}`).bind(venueId).all();
      return json(results.map((r) => kind.out(r, origin)));
    }
    if (method === "POST") {
      const row = kind.parse(await readJson(request), venueId, await screenIds(db, venueId), venue);
      const id = crypto.randomUUID();
      const now = Date.now();
      const cols = ["id", "venue_id", ...kind.columns, "updated_at"];
      await db.batch([
        db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
          .bind(id, venueId, ...kind.columns.map((c) => row[c]), now),
        bump(db, venueId),
      ]);
      return json(kind.out({ id, ...row, updated_at: now }, origin), 201);
    }
    throw new HttpError(405, "Method not allowed");
  }
  const existing = await db.prepare(`SELECT * FROM ${table} WHERE id = ? AND venue_id = ?`).bind(itemId, venueId).first();
  if (!existing) throw new HttpError(404, "Not found");
  if (method === "GET") return json(kind.out(existing, origin));
  if (method === "PUT") {
    const row = kind.parse(await readJson(request), venueId, await screenIds(db, venueId), venue);
    const now = Date.now();
    await db.batch([
      db.prepare(`UPDATE ${table} SET ${kind.columns.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
        .bind(...kind.columns.map((c) => row[c]), now, itemId),
      bump(db, venueId),
    ]);
    return json(kind.out({ id: itemId, ...row, updated_at: now }, origin));
  }
  if (method === "DELETE") {
    await db.batch([db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(itemId), bump(db, venueId)]);
    return new Response(null, { status: 204 });
  }
  throw new HttpError(405, "Method not allowed");
}

/** Staff typed the code a TV is showing. Creates the screen; the TV collects its token on its next check. */
async function claimScreen(request, db, venueId) {
  const body = await readJson(request);
  const code = normalizeCode(body.code);
  if (!code) throw new HttpError(400, "Enter the 6-character code shown on the TV");
  const name = v.text(body.name, "name", { max: 60, required: true });
  const now = Date.now();
  await cleanUpPairings(db, now);
  const pairing = await db.prepare("SELECT * FROM pairings WHERE code = ?").bind(code).first();
  if (!pairing) throw new HttpError(404, "No TV is showing that code. Codes last 10 minutes; check it or get a new one");
  if (pairing.screen_id) throw new HttpError(409, "That code has already been used");
  const id = crypto.randomUUID();
  const results = await db.batch([
    db.prepare("INSERT INTO screens (id, venue_id, name, created_at) VALUES (?, ?, ?, ?)").bind(id, venueId, name, now),
    db.prepare("UPDATE pairings SET screen_id = ?, expires_at = ? WHERE code = ? AND screen_id IS NULL")
      .bind(id, now + PAIR_CLAIM_TTL, code),
  ]);
  if (results[1].meta.changes !== 1) {
    await db.prepare("DELETE FROM screens WHERE id = ?").bind(id).run();
    throw new HttpError(409, "That code has already been used");
  }
  return json({ id, name, layout: "full", linked: false, lastSeen: null, appVersion: null, createdAt: now }, 201);
}

async function uploadImage(request, env, venueId, origin) {
  const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const ext = IMAGE_TYPES[type];
  if (!ext) throw new HttpError(415, "Upload a PNG, JPEG, WebP or GIF image");
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_IMAGE_BYTES) throw new HttpError(413, "Images must be 5 MB or smaller");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) throw new HttpError(400, "The image is empty");
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new HttpError(413, "Images must be 5 MB or smaller");
  const key = `${venueId}/${crypto.randomUUID()}.${ext}`;
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: type } });
  return json({ key, url: imageUrl(origin, key) }, 201);
}

async function deleteImagesWithPrefix(bucket, prefix) {
  let cursor;
  do {
    const list = await bucket.list({ prefix, cursor });
    if (list.objects.length) await bucket.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}
