import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";

const OWNER = "owner@example.com";
const LOCAL = "http://localhost";

/** Calls the Worker as [as] (an admin email), as if signed in through the local dev bypass. */
async function call(method, path, { body, as = OWNER, headers = {}, base = LOCAL, raw, cf } = {}) {
  const init = { method, headers: { ...headers } };
  if (cf) init.cf = cf;
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

describe("app download links", () => {
  it("sends /apk and apk.<domain> to the newest release", async () => {
    for (const [base, path] of [[LOCAL, "/apk"], [LOCAL, "/apk/"], ["https://apk.example.com", "/"], ["https://apk.example.com", "/anything"]]) {
      const r = await call("GET", path, { base });
      expect(r.status).toBe(302);
      expect(r.headers.get("Location")).toBe("https://github.com/zapiltar/OpenGuide/releases/latest/download/OpenGuide.apk");
    }
  });
});

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

describe("weather", () => {
  afterEach(() => vi.restoreAllMocks());

  const hour = (offset, temp, symbol) => ({
    time: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 + offset * 3_600_000).toISOString(),
    data: { instant: { details: { air_temperature: temp } }, next_1_hours: { summary: { symbol_code: symbol } } },
  });

  /** Stands in for Zippopotam.us and MET Norway, counting forecast requests. */
  function fakeServices() {
    const calls = { forecast: 0, lastForecast: null };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://api.zippopotam.us/us/10001")) {
        return Response.json({ places: [{ "place name": "New York City", "state abbreviation": "NY", latitude: "40.7484", longitude: "-73.9967" }] });
      }
      if (url.startsWith("https://api.zippopotam.us/")) return new Response("{}", { status: 404 });
      if (url.startsWith("https://api.met.no/")) {
        calls.forecast++;
        calls.lastForecast = url;
        expect(new Headers(init?.headers).get("User-Agent")).toMatch(/^OpenGuide-Bar/);
        return Response.json({ properties: { timeseries: [hour(0, 20, "partlycloudy_night"), hour(1, 25, "rain")] } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    return calls;
  }

  const weather = (token, cf) => call("GET", "/api/tv/weather", { headers: { Authorization: `Bearer ${token}` }, cf });

  it("uses the bar's ZIP code, in Fahrenheit, and shares one forecast between requests", async () => {
    const calls = fakeServices();
    const venue = await newVenue();
    const { token } = await linkTv(venue.id);
    const set = await call("PATCH", `/api/admin/venues/${venue.id}`, { body: { weatherZip: "10001" } });
    expect(set.body).toMatchObject({ weatherZip: "10001", weatherPlace: "New York City, NY" });
    const r = await weather(token);
    expect(r.body.weather).toEqual({ temp: 68, unit: "F", kind: "partly", day: false, place: "New York City, NY", source: "zip" });
    expect(calls.lastForecast).toContain("lat=40.75&lon=-74.00");
    await weather(token);
    expect(calls.forecast).toBe(1);
  });

  it("falls back to where the TV's address is, in Celsius outside the US", async () => {
    fakeServices();
    const venue = await newVenue();
    const { token } = await linkTv(venue.id);
    const r = await weather(token, { latitude: "51.5", longitude: "-0.12", city: "London", country: "GB" });
    expect(r.body.weather).toMatchObject({ temp: 20, unit: "C", place: "London", source: "ip" });
    expect((await weather(token)).body.weather).toBe(null);
  });

  it("refuses ZIP codes that don't exist or aren't ZIP codes, and can clear one", async () => {
    fakeServices();
    const venue = await newVenue();
    expect((await call("PATCH", `/api/admin/venues/${venue.id}`, { body: { weatherZip: "99999" } })).status).toBe(400);
    expect((await call("PATCH", `/api/admin/venues/${venue.id}`, { body: { weatherZip: "SW1A" } })).status).toBe(400);
    await call("PATCH", `/api/admin/venues/${venue.id}`, { body: { weatherZip: "10001" } });
    const cleared = await call("PATCH", `/api/admin/venues/${venue.id}`, { body: { weatherZip: "" } });
    expect(cleared.body).toMatchObject({ weatherZip: null, weatherPlace: null });
  });

  it("needs a linked TV", async () => {
    expect((await call("GET", "/api/tv/weather", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
  });
});

describe("bingo", () => {
  const as = (token) => ({ headers: { Authorization: `Bearer ${token}` } });
  const bingo = (token, action, headers = {}) =>
    action
      ? call("POST", `/api/tv/bingo/${action}`, { headers: { Authorization: `Bearer ${token}` } })
      : call("GET", "/api/tv/bingo", { headers: { Authorization: `Bearer ${token}`, ...headers } });

  it("lets one TV host and call numbers that every TV sees", async () => {
    const venue = await newVenue();
    const left = await linkTv(venue.id, "Bar left");
    const right = await linkTv(venue.id, "Bar right");
    expect((await tv(left.token)).body.venue.bingo).toBe(true);

    const start = await bingo(left.token);
    expect(start.body).toMatchObject({ game: 1, called: [], host: false, hostName: null });

    // Only the host can call.
    expect((await bingo(left.token, "call")).status).toBe(403);
    expect((await bingo(left.token, "host")).body).toMatchObject({ host: true, hostName: "Bar left" });
    const first = await bingo(left.token, "call");
    expect(first.body.called).toHaveLength(1);
    const n = first.body.called[0];
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(75);

    const seen = await bingo(right.token);
    expect(seen.body).toMatchObject({ called: [n], host: false, hostName: "Bar left" });
    // Nothing changed, so the other TV gets a 304.
    expect((await bingo(right.token, null, { "If-None-Match": seen.headers.get("ETag") })).status).toBe(304);

    // The other TV can take over; then the first can't call any more.
    expect((await bingo(right.token, "host")).body).toMatchObject({ host: true, hostName: "Bar right" });
    expect((await bingo(left.token, "call")).status).toBe(403);
    expect((await bingo(left.token)).body).toMatchObject({ host: false, hostName: "Bar right" });
  });

  it("never calls a number twice, and stops after 75", async () => {
    const venue = await newVenue();
    const { token } = await linkTv(venue.id);
    await bingo(token, "host");
    let last;
    for (let i = 0; i < 75; i++) last = await bingo(token, "call");
    expect(new Set(last.body.called).size).toBe(75);
    expect([...last.body.called].sort((a, b) => a - b)).toEqual(Array.from({ length: 75 }, (_, i) => i + 1));
    expect((await bingo(token, "call")).status).toBe(409);
  });

  it("takes back the last call, starts new games, and stops hosting", async () => {
    const venue = await newVenue();
    const { token } = await linkTv(venue.id);
    await bingo(token, "host");
    await bingo(token, "call");
    const two = await bingo(token, "call");
    const undone = await bingo(token, "undo");
    expect(undone.body.called).toEqual(two.body.called.slice(0, 1));
    const fresh = await bingo(token, "new");
    expect(fresh.body).toMatchObject({ game: 2, called: [], host: true });
    expect((await bingo(token, "unhost")).body).toMatchObject({ host: false, hostName: null });
    expect((await bingo(token, "dance")).status).toBe(404);
  });

  it("lets the host set what wins, which a new game keeps", async () => {
    const venue = await newVenue();
    const host = await linkTv(venue.id, "Bar left");
    const other = await linkTv(venue.id, "Bar right");
    expect((await bingo(host.token)).body.pattern).toBe("regular");
    const set = (token, pattern) =>
      call("POST", "/api/tv/bingo/pattern", { body: { pattern }, headers: { Authorization: `Bearer ${token}` } });
    expect((await set(host.token, "x")).status).toBe(403);
    await bingo(host.token, "host");
    expect((await set(host.token, "x")).body.pattern).toBe("x");
    expect((await set(host.token, "star")).status).toBe(400);
    expect((await bingo(other.token)).body.pattern).toBe("x");
    await bingo(host.token, "call");
    expect((await bingo(host.token, "new")).body).toMatchObject({ called: [], pattern: "x" });
    for (const p of ["regular", "z", "box", "coverall"]) expect((await set(host.token, p)).body.pattern).toBe(p);
  });

  /** Opens the live connection as [token]'s TV, collecting what the server sends. */
  async function live(token) {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${LOCAL}/api/tv/bingo/live`, { headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` } }),
      env,
      ctx,
    );
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    const messages = [];
    const waiting = [];
    ws.addEventListener("message", (e) => {
      messages.push(e.data);
      waiting.splice(0).forEach((resolve) => resolve());
    });
    ws.accept();
    /** Waits until at least [n] messages have arrived. */
    const next = async (n) => {
      for (let i = 0; i < 50 && messages.length < n; i++) await new Promise((r) => { waiting.push(r); setTimeout(r, 100); });
      expect(messages.length).toBeGreaterThanOrEqual(n);
      return messages[n - 1];
    };
    return { ws, messages, next };
  }

  it("sends every change straight to the TVs showing the board", async () => {
    const venue = await newVenue();
    const left = await linkTv(venue.id, "Bar left");
    const right = await linkTv(venue.id, "Bar right");
    const watcher = await live(right.token);
    // The game as it is, as soon as it connects.
    expect(JSON.parse(await watcher.next(1))).toMatchObject({ game: 1, called: [], host: false });

    await bingo(left.token, "host");
    expect(JSON.parse(await watcher.next(2))).toMatchObject({ host: false, hostName: "Bar left" });
    const called = (await bingo(left.token, "call")).body.called;
    expect(JSON.parse(await watcher.next(3))).toMatchObject({ called, host: false });

    // Each TV is told whether it's the host.
    const hostSocket = await live(left.token);
    expect(JSON.parse(await hostSocket.next(1))).toMatchObject({ called, host: true });

    // "ping" gets "pong", so the TV knows the connection still works.
    watcher.ws.send("ping");
    expect(await watcher.next(4)).toBe("pong");
    watcher.ws.close();
    hostSocket.ws.close();
  });

  it("takes the host's actions over its live connection", async () => {
    const venue = await newVenue();
    const left = await linkTv(venue.id, "Bar left");
    const right = await linkTv(venue.id, "Bar right");
    const host = await live(left.token);
    const watcher = await live(right.token);
    const first = JSON.parse(await host.next(1));
    await watcher.next(1);

    // A TV that isn't hosting is told it can't call.
    watcher.ws.send(JSON.stringify({ action: "call" }));
    expect(JSON.parse(await watcher.next(2))).toEqual({ error: "Only the TV hosting bingo can do that" });

    host.ws.send(JSON.stringify({ action: "host" }));
    const hosting = JSON.parse(await host.next(2));
    expect(hosting).toMatchObject({ host: true, hostName: "Bar left", version: first.version + 1 });
    host.ws.send(JSON.stringify({ action: "call", version: hosting.version }));
    const called = JSON.parse(await host.next(3));
    expect(called.called).toHaveLength(1);
    // Every TV hears about it, the one that isn't hosting included.
    expect(JSON.parse(await watcher.next(4))).toMatchObject({ called: called.called, host: false });
    host.ws.close();
    watcher.ws.close();
  });

  it("ignores double and triple presses made from the same board", async () => {
    const venue = await newVenue();
    const { token } = await linkTv(venue.id);
    const hosting = (await bingo(token, "host")).body;
    const press = () => call("POST", "/api/tv/bingo/call", { body: { version: hosting.version }, headers: { Authorization: `Bearer ${token}` } });
    const results = await Promise.all([press(), press(), press()]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await bingo(token)).body.called).toHaveLength(1);
    // A press from the board as it is now still works.
    const now = (await bingo(token)).body;
    const next = await call("POST", "/api/tv/bingo/call", { body: { version: now.version }, headers: { Authorization: `Bearer ${token}` } });
    expect(next.body.called).toHaveLength(2);
  });

  it("carries on a game that was in the database before bingo rooms kept it", async () => {
    const venue = await newVenue();
    const { token, screenId } = await linkTv(venue.id, "Bar left");
    await env.DB.prepare("INSERT INTO bingo_games (venue_id, game, called, host_screen_id, pattern, version, updated_at) VALUES (?, 4, '[5,40]', ?, 'x', 9, 0)")
      .bind(venue.id, screenId).run();
    expect((await bingo(token)).body).toEqual({ game: 4, called: [5, 40], host: true, hostName: "Bar left", pattern: "x", version: 9 });
  });

  it("only takes WebSockets from linked TVs", async () => {
    const venue = await newVenue();
    const { token } = await linkTv(venue.id);
    expect((await call("GET", "/api/tv/bingo/live", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(426);
    expect((await call("GET", "/api/tv/bingo/live", { headers: { Upgrade: "websocket", Authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("can be turned off for a bar", async () => {
    const venue = await newVenue();
    const { token } = await linkTv(venue.id);
    const off = await call("PATCH", `/api/admin/venues/${venue.id}`, { body: { bingo: false } });
    expect(off.body.bingo).toBe(false);
    expect((await tv(token)).body.venue.bingo).toBe(false);
    expect((await bingo(token)).status).toBe(403);
    expect((await bingo(token, "host")).status).toBe(403);
    expect((await call("PATCH", `/api/admin/venues/${venue.id}`, { body: { bingo: "yes" } })).status).toBe(400);
  });

  it("needs a linked TV", async () => {
    expect((await call("GET", "/api/tv/bingo", as("nope"))).status).toBe(401);
  });
});
