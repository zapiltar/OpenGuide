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
    expect(r.body.venue).toEqual({ name: "Joe's", logo: `${LOCAL}/img/${upload.body.key}`, timezone: "America/Chicago" });
    expect(r.body.menus[0].sections[0].items[0]).toEqual({ name: "Lager", price: "$5", description: null });
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
    await call("POST", `/api/admin/venues/${mine.id}/staff`, { body: { email: "Staff@Example.com" } });
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

describe("Cloudflare Access sign-in", () => {
  afterEach(() => vi.restoreAllMocks());

  const DOMAIN = "bars.cloudflareaccess.com";
  const AUD = "test-aud";
  const deployed = { ...env, DEV_ADMIN_EMAIL: OWNER, ACCESS_TEAM_DOMAIN: DOMAIN, ACCESS_AUD: AUD };

  async function signer() {
    const { privateKey, publicKey } = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1" };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      expect(String(url)).toBe(`https://${DOMAIN}/cdn-cgi/access/certs`);
      return Response.json({ keys: [jwk] });
    });
    const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    return async (claims) => {
      const head = b64({ alg: "RS256", kid: "k1" });
      const body = b64({ iss: `https://${DOMAIN}`, aud: [AUD], exp: Date.now() / 1000 + 600, email: OWNER, ...claims });
      const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${head}.${body}`));
      const s = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
      return `${head}.${body}.${s}`;
    };
  }

  const asDeployed = async (headers = {}) => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://bar.example.com/api/admin/me", { headers }), deployed, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };

  it("ignores the dev sign-in away from localhost", async () => {
    expect((await asDeployed()).status).toBe(401);
  });

  it("refuses to run without Access settings away from localhost", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://bar.example.com/api/admin/me"), { ...env, DEV_ADMIN_EMAIL: OWNER }, ctx);
    expect(res.status).toBe(503);
  });

  it("accepts a valid token and rejects tampered or wrong ones", async () => {
    const sign = await signer();
    const ok = await asDeployed({ "Cf-Access-Jwt-Assertion": await sign({}) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ email: OWNER, owner: true });

    const good = await sign({});
    const [h, , s] = good.split(".");
    const forged = btoa(JSON.stringify({ iss: `https://${DOMAIN}`, aud: [AUD], exp: Date.now() / 1000 + 600, email: "x@evil.com" }))
      .replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    expect((await asDeployed({ "Cf-Access-Jwt-Assertion": `${h}.${forged}.${s}` })).status).toBe(401);
    expect((await asDeployed({ "Cf-Access-Jwt-Assertion": await sign({ aud: ["other"] }) })).status).toBe(401);
    expect((await asDeployed({ "Cf-Access-Jwt-Assertion": await sign({ exp: Date.now() / 1000 - 10 }) })).status).toBe(401);
    expect((await asDeployed({ "Cf-Access-Jwt-Assertion": await sign({ iss: "https://evil.example" }) })).status).toBe(401);
  });
});
