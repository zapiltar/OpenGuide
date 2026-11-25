import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";

const OWNER = "owner@example.com";
const LOCAL = "http://localhost";

/** Calls the Worker as [as] (an admin email), as if signed in through the local dev bypass. */
async function call(method, path, { body, as = OWNER, headers = {}, base = LOCAL, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
  }
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(base + path, init), { ...env, DEV_ADMIN_EMAIL: as }, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? safeJson(text) : null };
}

function safeJson(t) {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

async function newVenue(name = "The Local", timezone = "America/New_York") {
  const r = await call("POST", "/api/admin/venues", { body: { name, timezone } });
  expect(r.status).toBe(201);
  return r.body;
}

/** Runs the whole TV linking flow and returns the screen token. */
async function linkTv(venueId, name = "Bar left") {
  const pair = await call("POST", "/api/tv/pair");
  expect(pair.status).toBe(201);
  expect(pair.body.code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
  const waiting = await call("POST", "/api/tv/pair/status", { body: { code: pair.body.code, secret: pair.body.secret } });
  expect(waiting.body.status).toBe("waiting");
  const claim = await call("POST", `/api/admin/venues/${venueId}/screens`, {
    body: { code: pair.body.code.toLowerCase().replace("-", " "), name },
  });
  expect(claim.status).toBe(201);
  const linked = await call("POST", "/api/tv/pair/status", { body: { code: pair.body.code, secret: pair.body.secret } });
  expect(linked.body.status).toBe("linked");
  return { token: linked.body.token, screenId: claim.body.id, code: pair.body.code, secret: pair.body.secret };
}

const tv = (token, headers = {}) => call("GET", "/api/tv/feed", { headers: { Authorization: `Bearer ${token}`, ...headers } });

describe("linking a TV", () => {
  it("links once, and the code can't be reused", async () => {
    const venue = await newVenue();
    const { token, code, secret } = await linkTv(venue.id);
    expect(token.length).toBeGreaterThan(30);
    const again = await call("POST", "/api/tv/pair/status", { body: { code, secret } });
    expect(again.status).toBe(404);
    const reclaim = await call("POST", `/api/admin/venues/${venue.id}/screens`, { body: { code, name: "Another" } });
    expect(reclaim.status).toBe(404);
  });

  it("won't reveal a pairing to the wrong secret", async () => {
    const pair = await call("POST", "/api/tv/pair");
    const r = await call("POST", "/api/tv/pair/status", { body: { code: pair.body.code, secret: "guess" } });
    expect(r.status).toBe(404);
  });

  it("rejects a code no TV is showing", async () => {
    const venue = await newVenue();
    const r = await call("POST", `/api/admin/venues/${venue.id}/screens`, { body: { code: "AAA-AAA", name: "X" } });
    expect(r.status).toBe(404);
  });

  it("stops the feed when the screen is removed", async () => {
    const venue = await newVenue();
    const { token, screenId } = await linkTv(venue.id);
    expect((await tv(token)).status).toBe(200);
    expect((await call("DELETE", `/api/admin/venues/${venue.id}/screens/${screenId}`)).status).toBe(204);
    expect((await tv(token)).status).toBe(401);
  });

  it("removes the screen when the TV unlinks itself", async () => {
    const venue = await newVenue();
    const { token } = await linkTv(venue.id);
    const r = await call("POST", "/api/tv/unlink", { headers: { Authorization: `Bearer ${token}` } });
    expect(r.status).toBe(204);
    expect((await call("GET", `/api/admin/venues/${venue.id}/screens`)).body).toEqual([]);
    expect((await tv(token)).status).toBe(401);
  });

  it("refuses a feed request without a valid token", async () => {
    expect((await call("GET", "/api/tv/feed")).status).toBe(401);
    expect((await tv("not-a-token")).status).toBe(401);
  });
});

describe("the feed", () => {
  it("carries branding, menus, events and specials, and records the screen as seen", async () => {
    const venue = await newVenue("Joe's Tap", "America/Chicago");
    const { token, screenId } = await linkTv(venue.id);
    const upload = await call("POST", `/api/admin/venues/${venue.id}/images`, {
      raw: new Uint8Array([137, 80, 78, 71]),
      headers: { "Content-Type": "image/png" },
    });
    expect(upload.status).toBe(201);
    await call("PATCH", `/api/admin/venues/${venue.id}`, { body: { displayName: "Joe's", logo: upload.body.key } });
    await call("POST", `/api/admin/venues/${venue.id}/menus`, {
      body: { title: "Drinks", kind: "list", sections: [{ title: "Beer", items: [{ name: "Lager", price: "$5" }] }] },
    });
    const now = Date.now();
    await call("POST", `/api/admin/venues/${venue.id}/events`, {
      body: { title: "Trivia", start: now + 86_400_000, end: now + 90_000_000 },
    });
    await call("POST", `/api/admin/venues/${venue.id}/specials`, {
      body: { title: "Happy hour", text: "$3 drafts", schedule: { type: "weekly", days: [0, 1, 2, 3, 4, 5, 6], start: "16:00", end: "19:00" } },
    });
    await call("POST", `/api/admin/venues/${venue.id}/specials`, {
      body: { title: "Off", enabled: false, schedule: { type: "weekly", days: [1], start: "10:00", end: "11:00" } },
    });

    const r = await tv(token, { "X-App-Version": "1.4.0" });
    expect(r.status).toBe(200);
    expect(r.body.venue).toMatchObject({ name: "Joe's", logo: `${LOCAL}/img/${upload.body.key}`, timezone: "America/Chicago", theme: null });
    expect(r.body.screen).toMatchObject({ id: screenId, layout: "full" });
    expect(r.body.menus[0].sections[0].items[0]).toEqual({ name: "Lager", price: "$5", description: null, image: null });
    expect(r.body.events.map((e) => e.title)).toEqual(["Trivia"]);
    expect(r.body.specials.map((s) => s.title)).toEqual(["Happy hour"]);
    const happy = r.body.specials[0];
    expect(happy.display).toBe("banner");
    expect(happy.timeoutSeconds).toBe(30);
    expect(happy.occurrences.length).toBeGreaterThanOrEqual(7);
    expect(happy.occurrences.every((o) => o.end - o.start === 3 * 3_600_000)).toBe(true);

    await tv(token); // a request without a version keeps the one already known
    const screens = await call("GET", `/api/admin/venues/${venue.id}/screens`);
    expect(screens.body).toMatchObject([{ id: screenId, linked: true, appVersion: "1.4.0" }]);
    expect(screens.body[0].lastSeen).toBeGreaterThan(0);

    const img = await call("GET", `/img/${upload.body.key}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("Content-Type")).toBe("image/png");
  });

  it("answers 304 until something changes", async () => {
    const venue = await newVenue();
    const { token } = await linkTv(venue.id);
    const first = await tv(token);
    const etag = first.headers.get("ETag");
    expect((await tv(token, { "If-None-Match": etag })).status).toBe(304);
    await call("POST", `/api/admin/venues/${venue.id}/specials`, {
      body: { title: "Wings", schedule: { type: "weekly", days: [2], start: "17:00", end: "21:00" } },
    });
    const changed = await tv(token, { "If-None-Match": etag });
    expect(changed.status).toBe(200);
    expect(changed.body.specials.map((s) => s.title)).toEqual(["Wings"]);
  });

  it("only sends items to the screens they're meant for", async () => {
    const venue = await newVenue();
    const a = await linkTv(venue.id, "A");
    const b = await linkTv(venue.id, "B");
    await call("POST", `/api/admin/venues/${venue.id}/menus`, {
      body: { title: "Only A", kind: "list", sections: [{ items: [{ name: "x" }] }], screens: [a.screenId] },
    });
    expect((await tv(a.token)).body.menus.map((m) => m.title)).toEqual(["Only A"]);
    expect((await tv(b.token)).body.menus).toEqual([]);
  });
});

describe("look and layout", () => {
  it("saves a two-color theme, sends it to TVs, and can go back to the default", async () => {
    const venue = await newVenue();
    const { token } = await linkTv(venue.id);
    const set = await call("PATCH", `/api/admin/venues/${venue.id}`, { body: { theme: { primary: "#1B5E20", secondary: "#FFC107" } } });
    expect(set.body.theme).toEqual({ primary: "#1b5e20", secondary: "#ffc107" });
    expect((await tv(token)).body.venue.theme).toEqual({ primary: "#1b5e20", secondary: "#ffc107" });
    await call("PATCH", `/api/admin/venues/${venue.id}`, { body: { theme: null } });
    expect((await tv(token)).body.venue.theme).toBe(null);
  });

  it("lets a TV switch its own layout, which the site then shows", async () => {
    const venue = await newVenue();
    const { token, screenId } = await linkTv(venue.id);
    const before = (await tv(token)).headers.get("ETag");
    const r = await call("POST", "/api/tv/layout", { body: { layout: "framed" }, headers: { Authorization: `Bearer ${token}` } });
    expect(r.body).toEqual({ layout: "framed" });
    const after = await tv(token, { "If-None-Match": before });
    expect(after.status).toBe(200);
    expect(after.body.screen.layout).toBe("framed");
    expect((await call("GET", `/api/admin/venues/${venue.id}/screens`)).body[0]).toMatchObject({ id: screenId, layout: "framed" });
    expect((await call("POST", "/api/tv/layout", { body: { layout: "huge" }, headers: { Authorization: `Bearer ${token}` } })).status).toBe(400);
    expect((await call("POST", "/api/tv/layout", { body: { layout: "full" }, headers: { Authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("rejects colors that aren't #rrggbb", async () => {
    const venue = await newVenue();
    for (const theme of [{ primary: "red", secondary: "#ffffff" }, { primary: "#fff", secondary: "#ffffff" }, "blue"]) {
      expect((await call("PATCH", `/api/admin/venues/${venue.id}`, { body: { theme } })).status).toBe(400);
    }
  });

  it("switches a screen to the framed layout", async () => {
    const venue = await newVenue();
    const { token, screenId } = await linkTv(venue.id);
    const r = await call("PATCH", `/api/admin/venues/${venue.id}/screens/${screenId}`, { body: { layout: "framed" } });
    expect(r.body).toEqual({ id: screenId, name: "Bar left", layout: "framed" });
    expect((await tv(token)).body.screen.layout).toBe("framed");
    expect((await call("PATCH", `/api/admin/venues/${venue.id}/screens/${screenId}`, { body: { layout: "tiny" } })).status).toBe(400);
  });

  it("can frame a screen only while a special is on, from the site or the TV", async () => {
    const venue = await newVenue();
    const { token, screenId } = await linkTv(venue.id);
    await call("PATCH", `/api/admin/venues/${venue.id}/screens/${screenId}`, { body: { layout: "specials" } });
    expect((await tv(token)).body.screen.layout).toBe("specials");
    await call("POST", "/api/tv/layout", { body: { layout: "full" }, headers: { Authorization: `Bearer ${token}` } });
    await call("POST", "/api/tv/layout", { body: { layout: "specials" }, headers: { Authorization: `Bearer ${token}` } });
    expect((await call("GET", `/api/admin/venues/${venue.id}/screens`)).body[0].layout).toBe("specials");
  });
});

describe("menu item pictures", () => {
  it("keeps a picture on an item, and sends the TV its address", async () => {
    const venue = await newVenue();
    const { token } = await linkTv(venue.id);
    const up = await call("POST", `/api/admin/venues/${venue.id}/images`, { raw: new Uint8Array([1]), headers: { "Content-Type": "image/png" } });
    const menu = await call("POST", `/api/admin/venues/${venue.id}/menus`, {
      body: { title: "Food", kind: "list", sections: [{ items: [{ name: "Wings", image: up.body.key }, { name: "Fries" }] }] },
    });
    expect(menu.status).toBe(201);
    const [wings, fries] = menu.body.sections[0].items;
    expect(wings).toMatchObject({ name: "Wings", image: up.body.key, imageUrl: up.body.url });
    expect(fries).toMatchObject({ image: null, imageUrl: null });
    const items = (await tv(token)).body.menus[0].sections[0].items;
    expect(items[0]).toEqual({ name: "Wings", price: null, description: null, image: up.body.url });
    expect(items[1].image).toBe(null);
  });

  it("refuses another bar's picture", async () => {
    const venue = await newVenue();
    const other = await newVenue();
    const up = await call("POST", `/api/admin/venues/${other.id}/images`, { raw: new Uint8Array([1]), headers: { "Content-Type": "image/png" } });
    const r = await call("POST", `/api/admin/venues/${venue.id}/menus`, {
      body: { title: "Food", kind: "list", sections: [{ items: [{ name: "Wings", image: up.body.key }] }] },
    });
    expect(r.status).toBe(400);
  });
});

describe("bar channel settings", () => {
  it("defaults to everything, saves changes, and sends them to TVs", async () => {
    const venue = await newVenue();
    const { token } = await linkTv(venue.id);
    expect(venue.channel).toEqual({ enabled: true, onNow: true, later: true, events: true, posters: true, hiddenMenus: [], seconds: 12 });
    const menu = await call("POST", `/api/admin/venues/${venue.id}/menus`, { body: { title: "Food", kind: "list", sections: [{ items: [{ name: "Wings" }] }] } });
    const r = await call("PATCH", `/api/admin/venues/${venue.id}`, {
      body: { channel: { posters: false, seconds: 20, hiddenMenus: [menu.body.id, "not-a-menu"] } },
    });
    expect(r.body.channel).toEqual({ enabled: true, onNow: true, later: true, events: true, posters: false, hiddenMenus: [menu.body.id], seconds: 20 });
    expect((await tv(token)).body.venue.channel).toMatchObject({ posters: false, seconds: 20, hiddenMenus: [menu.body.id] });
    // Changing one thing keeps the rest.
    const off = await call("PATCH", `/api/admin/venues/${venue.id}`, { body: { channel: { enabled: false } } });
    expect(off.body.channel).toMatchObject({ enabled: false, posters: false, seconds: 20 });
  });

  it("rejects odd settings", async () => {
    const venue = await newVenue();
    for (const channel of [{ seconds: 7 }, { posters: "no" }, { hiddenMenus: "all" }, "off"]) {
      expect((await call("PATCH", `/api/admin/venues/${venue.id}`, { body: { channel } })).status).toBe(400);
    }
  });
});

describe("repeating events", () => {
  const dayOf = (t, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  const weekday = (t, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(t);
  const clock = (t, tz) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(t);

  it("sends a weekly event's next two dates, at the right local time", async () => {
    const tz = "America/New_York";
    const venue = await newVenue("Trivia Bar", tz);
    const { token } = await linkTv(venue.id);
    const today = dayOf(Date.now(), tz);
    const created = await call("POST", `/api/admin/venues/${venue.id}/events`, {
      body: { title: "Trivia", repeat: { days: [2], start: "20:00", end: "22:00", from: today, until: null } },
    });
    expect(created.status).toBe(201);
    expect(created.body.repeat).toEqual({ days: [2], start: "20:00", end: "22:00", from: today, until: null });
    const events = (await tv(token)).body.events;
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(weekday(e.start, tz)).toBe("Tue");
      expect(clock(e.start, tz)).toBe("20:00");
      expect(e.end - e.start).toBe(2 * 3_600_000);
      expect(e.id.startsWith(`${created.body.id}@`)).toBe(true);
      expect(Number(e.id.split("@")[1])).toBe(e.start);
    }
    expect(events[1].start - events[0].start).toBe(7 * 86_400_000);
  });

  it("keeps an open-ended start time open, mixes with one-time events, and stops after the until date", async () => {
    const tz = "UTC";
    const venue = await newVenue("Music Bar", tz);
    const { token } = await linkTv(venue.id);
    const now = Date.now();
    const today = dayOf(now, tz);
    await call("POST", `/api/admin/venues/${venue.id}/events`, {
      body: { title: "Live music", repeat: { days: [0, 1, 2, 3, 4, 5, 6], start: "23:59", from: today, until: today } },
    });
    await call("POST", `/api/admin/venues/${venue.id}/events`, { body: { title: "Quiz final", start: now + 3 * 86_400_000 } });
    const events = (await tv(token)).body.events;
    expect(events.map((e) => e.title)).toEqual(["Live music", "Quiz final"]);
    expect(events[0].end).toBe(null);
    expect(dayOf(events[0].start, tz)).toBe(today);
  });

  it("hides a repeating event that has ended or hasn't started", async () => {
    const venue = await newVenue("Old Bar", "UTC");
    const { token } = await linkTv(venue.id);
    await call("POST", `/api/admin/venues/${venue.id}/events`, {
      body: { title: "Last season", repeat: { days: [1], start: "20:00", from: "2025-01-01", until: "2025-03-01" } },
    });
    await call("POST", `/api/admin/venues/${venue.id}/events`, {
      body: { title: "Next year", repeat: { days: [1], start: "20:00", from: "2099-01-01" } },
    });
    expect((await tv(token)).body.events).toEqual([]);
  });

  it("can show an event's picture full screen, which needs a picture", async () => {
    const venue = await newVenue();
    const { token } = await linkTv(venue.id);
    const url = `/api/admin/venues/${venue.id}/events`;
    const start = Date.now() + 86_400_000;
    expect((await call("POST", url, { body: { title: "Gig", start, fullScreen: true } })).status).toBe(400);
    const up = await call("POST", `/api/admin/venues/${venue.id}/images`, { raw: new Uint8Array([1]), headers: { "Content-Type": "image/png" } });
    const made = await call("POST", url, { body: { title: "Gig", start, image: up.body.key, fullScreen: true } });
    expect(made.body.fullScreen).toBe(true);
    expect((await tv(token)).body.events[0]).toMatchObject({ title: "Gig", fullScreen: true });
  });

  it("rejects bad repeats", async () => {
    const venue = await newVenue();
    const url = `/api/admin/venues/${venue.id}/events`;
    const bad = [
      { days: [], start: "20:00", from: "2026-01-01" },
      { days: [8], start: "20:00", from: "2026-01-01" },
      { days: [1], start: "8pm", from: "2026-01-01" },
      { days: [1], start: "20:00", end: "20:00", from: "2026-01-01" },
      { days: [1], start: "20:00", from: "2026-02-30" },
      { days: [1], start: "20:00", from: "2026-03-01", until: "2026-02-01" },
      { days: [1], start: "20:00" },
    ];
    for (const repeat of bad) {
      expect((await call("POST", url, { body: { title: "X", repeat } })).status, JSON.stringify(repeat)).toBe(400);
    }
  });
});

describe("special settings", () => {
  it("defaults the timeout by display, and only lets banners stay up until the end", async () => {
    const venue = await newVenue();
    const base = `/api/admin/venues/${venue.id}/specials`;
    const schedule = { type: "weekly", days: [1], start: "16:00", end: "18:00" };
    expect((await call("POST", base, { body: { title: "T", display: "takeover", schedule } })).body.timeoutSeconds).toBe(15);
    expect((await call("POST", base, { body: { title: "B", timeoutSeconds: null, schedule } })).body.timeoutSeconds).toBe(null);
    expect((await call("POST", base, { body: { title: "T", display: "takeover", timeoutSeconds: null, schedule } })).status).toBe(400);
    expect((await call("POST", base, { body: { title: "T", timeoutSeconds: 2, schedule } })).status).toBe(400);
    expect((await call("POST", base, { body: { title: "T", timeoutSeconds: 601, schedule } })).status).toBe(400);
    expect((await call("POST", base, { body: { title: "T", timeoutSeconds: 90, repeatMinutes: 20, schedule } })).body)
      .toMatchObject({ timeoutSeconds: 90, repeatMinutes: 20 });
  });

  it("shows a full-screen picture special, which needs a picture and a timeout", async () => {
    const venue = await newVenue();
    const { token } = await linkTv(venue.id);
    const base = `/api/admin/venues/${venue.id}/specials`;
    const schedule = { type: "weekly", days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" };
    expect((await call("POST", base, { body: { title: "Poster", display: "picture", schedule } })).status).toBe(400);
    const up = await call("POST", `/api/admin/venues/${venue.id}/images`, { raw: new Uint8Array([1]), headers: { "Content-Type": "image/png" } });
    expect((await call("POST", base, { body: { title: "Poster", display: "picture", image: up.body.key, timeoutSeconds: null, schedule } })).status).toBe(400);
    const made = await call("POST", base, { body: { title: "Poster", display: "picture", image: up.body.key, schedule } });
    expect(made.body).toMatchObject({ display: "picture", timeoutSeconds: 15 });
    expect((await call("GET", `${base}/${made.body.id}`)).body.display).toBe("picture");
    const s = (await tv(token)).body.specials[0];
    expect(s).toMatchObject({ display: "picture", image: `${LOCAL}/img/${up.body.key}` });
  });

  it("rejects bad schedules", async () => {
    const venue = await newVenue();
    const base = `/api/admin/venues/${venue.id}/specials`;
    const bad = [
      { type: "weekly", days: [], start: "16:00", end: "18:00" },
      { type: "weekly", days: [7], start: "16:00", end: "18:00" },
      { type: "weekly", days: [1], start: "4pm", end: "18:00" },
      { type: "weekly", days: [1], start: "16:00", end: "16:00" },
      { type: "once", start: Date.now() + 1000, end: Date.now() },
      { type: "monthly" },
    ];
    for (const schedule of bad) {
      expect((await call("POST", base, { body: { title: "X", schedule } })).status, JSON.stringify(schedule)).toBe(400);
    }
  });
});

describe("who can do what", () => {
  it("keeps staff to their own bar", async () => {
    const mine = await newVenue("Mine");
    const theirs = await newVenue("Theirs");
    await env.DB.prepare("INSERT INTO staff (venue_id, email, added_at, role) VALUES (?, ?, ?, 'staff')").bind(mine.id, "staff@example.com", Date.now()).run();
    const as = "staff@example.com";

    const list = await call("GET", "/api/admin/venues", { as });
    expect(list.body.map((x) => x.name)).toEqual(["Mine"]);
    expect((await call("GET", `/api/admin/venues/${theirs.id}`, { as })).status).toBe(404);
    expect((await call("GET", `/api/admin/venues/${theirs.id}/menus`, { as })).status).toBe(404);
    expect((await call("GET", `/api/admin/venues/${mine.id}/menus`, { as })).status).toBe(200);

    // Staff can brand their bar, but not rename it, add bars, or manage staff.
    expect((await call("PATCH", `/api/admin/venues/${mine.id}`, { as, body: { displayName: "Mine!" } })).status).toBe(200);
    expect((await call("PATCH", `/api/admin/venues/${mine.id}`, { as, body: { name: "Renamed" } })).status).toBe(403);
    expect((await call("POST", "/api/admin/venues", { as, body: { name: "New", timezone: "UTC" } })).status).toBe(403);
    expect((await call("GET", `/api/admin/venues/${mine.id}/staff`, { as })).status).toBe(403);

    expect((await call("GET", "/api/admin/venues", { as: "stranger@example.com" })).body).toEqual([]);
  });

  it("won't use another bar's image", async () => {
    const a = await newVenue("A");
    const b = await newVenue("B");
    const up = await call("POST", `/api/admin/venues/${a.id}/images`, { raw: new Uint8Array([1]), headers: { "Content-Type": "image/png" } });
    const r = await call("PATCH", `/api/admin/venues/${b.id}`, { body: { logo: up.body.key } });
    expect(r.status).toBe(400);
  });

  it("rejects writes from another site and non-JSON bodies", async () => {
    const r = await call("POST", "/api/admin/venues", { body: { name: "X", timezone: "UTC" }, headers: { Origin: "https://evil.example" } });
    expect(r.status).toBe(403);
    const form = await call("POST", "/api/admin/venues", { raw: "name=X", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(form.status).toBe(415);
  });

  it("rejects images that aren't images or are too big", async () => {
    const venue = await newVenue();
    const url = `/api/admin/venues/${venue.id}/images`;
    expect((await call("POST", url, { raw: "<svg/>", headers: { "Content-Type": "image/svg+xml" } })).status).toBe(415);
    expect((await call("POST", url, { raw: new Uint8Array(5 * 1024 * 1024 + 1), headers: { "Content-Type": "image/png" } })).status).toBe(413);
  });
});
