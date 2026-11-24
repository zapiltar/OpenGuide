import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";

// These run as a deployed site would: over HTTPS, with no local test sign-in, so only real accounts work.
const SITE = "https://bars.example.com";
const live = { ...env, DEV_ADMIN_EMAIL: undefined };
const PASSWORD = "correct horse battery";

let ipCounter = 0;
const freshIp = () => `203.0.113.${++ipCounter}`;

/** A browser: keeps its own cookie, like a real one would. */
function browser(ip = freshIp()) {
  let cookie = "";
  return {
    get cookie() { return cookie; },
    async call(method, path, body, headers = {}) {
      const init = { method, headers: { "CF-Connecting-IP": ip, ...headers } };
      if (cookie) init.headers.Cookie = cookie;
      if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers["Content-Type"] = "application/json";
      }
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(SITE + path, init), live, ctx);
      await waitOnExecutionContext(ctx);
      const set = res.headers.get("Set-Cookie");
      if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      return { status: res.status, body: data, setCookie: set };
    },
  };
}

let ownerCount = 0;
/** Sets the site up with an owner, signed in, unless it already has one, in which case it signs the owner in. */
async function owner() {
  const b = browser();
  const setup = await b.call("GET", "/api/auth/setup");
  if (setup.body.needed) {
    const r = await b.call("POST", "/api/auth/setup", { code: "test-setup-code-123", email: "boss@example.com", name: "Boss", password: PASSWORD });
    expect(r.status).toBe(201);
    ownerCount++;
  } else {
    expect((await b.call("POST", "/api/auth/login", { email: "boss@example.com", password: PASSWORD })).status).toBe(200);
  }
  return b;
}

async function barWithManager(name = "Corner Tap") {
  const boss = await owner();
  const bar = (await boss.call("POST", "/api/admin/venues", { name, timezone: "UTC" })).body;
  const invite = await boss.call("POST", `/api/admin/venues/${bar.id}/invites`, { role: "manager" });
  expect(invite.status).toBe(201);
  const token = invite.body.link.split("/join/")[1];
  const manager = browser();
  const email = `manager-${bar.id.slice(0, 8)}@example.com`;
  const joined = await manager.call("POST", `/api/auth/invite/${token}`, { email, name: "Manager", password: PASSWORD });
  expect(joined.status).toBe(201);
  return { boss, bar, manager, managerEmail: email };
}

describe("owner setup", () => {
  it("needs the setup code, then closes for good", async () => {
    const b = browser();
    const wrong = await b.call("POST", "/api/auth/setup", { code: "guess", email: "x@example.com", password: PASSWORD });
    expect(wrong.status).toBe(401);
    await owner();
    expect((await b.call("GET", "/api/auth/setup")).body.needed).toBe(false);
    const another = await b.call("POST", "/api/auth/setup", { code: "test-setup-code-123", email: "intruder@example.com", password: PASSWORD });
    expect(another.status).toBe(400);
  });

  it("lets the owner reset a forgotten password with the setup code", async () => {
    await owner();
    const b = browser();
    const r = await b.call("POST", "/api/auth/setup", { code: "test-setup-code-123", email: "boss@example.com", password: "a brand new password" });
    expect(r.status).toBe(200);
    expect((await browser().call("POST", "/api/auth/login", { email: "boss@example.com", password: PASSWORD })).status).toBe(401);
    // Put it back for the other tests.
    await b.call("POST", "/api/admin/account/password", { current: "a brand new password", password: PASSWORD });
  });

  it("makes the owner a super user who sees every bar", async () => {
    const { boss, bar } = await barWithManager("Owner Sees This");
    const list = (await boss.call("GET", "/api/admin/venues")).body;
    expect(list.map((x) => x.name)).toContain("Owner Sees This");
    expect((await boss.call("GET", `/api/admin/venues/${bar.id}`)).body.role).toBe("owner");
  });
});

describe("signing in", () => {
  it("uses a secure, HttpOnly cookie, and signing out ends the session", async () => {
    const b = await owner();
    const login = await browser().call("POST", "/api/auth/login", { email: "boss@example.com", password: PASSWORD });
    expect(login.setCookie).toMatch(/^__Host-og_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    expect((await b.call("GET", "/api/admin/me")).body).toMatchObject({ email: "boss@example.com", owner: true });
    await b.call("POST", "/api/auth/logout");
    expect((await b.call("GET", "/api/admin/me")).status).toBe(401);
  });

  it("refuses wrong passwords and unknown emails the same way", async () => {
    await owner();
    const b = browser();
    const wrong = await b.call("POST", "/api/auth/login", { email: "boss@example.com", password: "nope nope nope" });
    const unknown = await b.call("POST", "/api/auth/login", { email: "nobody@example.com", password: "nope nope nope" });
    expect(wrong).toMatchObject({ status: 401, body: { error: "Wrong email or password" } });
    expect(unknown).toMatchObject({ status: 401, body: { error: "Wrong email or password" } });
  });

  it("locks an account after 10 wrong passwords, even with the right one", async () => {
    const { managerEmail } = await barWithManager("Lockout Bar");
    for (let i = 0; i < 10; i++) {
      expect((await browser().call("POST", "/api/auth/login", { email: managerEmail, password: `wrong-${i}-xxxxxx` })).status).toBe(401);
    }
    const locked = await browser().call("POST", "/api/auth/login", { email: managerEmail, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toMatch(/Try again in 15 minutes/);
  });

  it("blocks an address after 30 wrong tries", async () => {
    const b = browser();
    for (let i = 0; i < 30; i++) await b.call("POST", "/api/auth/login", { email: `guess${i}@example.com`, password: "whatever-whatever" });
    expect((await b.call("POST", "/api/auth/login", { email: "boss@example.com", password: PASSWORD })).status).toBe(429);
  });

  it("needs a session for the admin API", async () => {
    expect((await browser().call("GET", "/api/admin/venues")).status).toBe(401);
    const forged = await browser().call("GET", "/api/admin/venues", undefined, { Cookie: "__Host-og_session=made-up-token" });
    expect(forged.status).toBe(401);
  });

  it("rejects sign-in attempts from other sites", async () => {
    await owner();
    const r = await browser().call("POST", "/api/auth/login", { email: "boss@example.com", password: PASSWORD }, { Origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });
});

describe("invites", () => {
  it("joins a new person to just that bar, once", async () => {
    const { boss, bar, manager } = await barWithManager("Invite Bar");
    const other = (await boss.call("POST", "/api/admin/venues", { name: "Someone Else's", timezone: "UTC" })).body;
    expect((await manager.call("GET", "/api/admin/venues")).body.map((x) => x.name)).toEqual(["Invite Bar"]);
    expect((await manager.call("GET", `/api/admin/venues/${other.id}`)).status).toBe(404);
    expect((await manager.call("GET", `/api/admin/venues/${bar.id}`)).body.role).toBe("manager");

    const invite = await manager.call("POST", `/api/admin/venues/${bar.id}/invites`, { role: "staff" });
    const token = invite.body.link.split("/join/")[1];
    expect((await browser().call("GET", `/api/auth/invite/${token}`)).body).toMatchObject({ bar: "Invite Bar", role: "staff" });
    const staff = browser();
    expect((await staff.call("POST", `/api/auth/invite/${token}`, { email: "newstaff@example.com", password: PASSWORD })).status).toBe(201);
    expect((await browser().call("POST", `/api/auth/invite/${token}`, { email: "second@example.com", password: PASSWORD })).status).toBe(404);
  });

  it("adds a bar to someone who already has an account, after checking their password", async () => {
    const first = await barWithManager("First Bar");
    const second = await barWithManager("Second Bar");
    const invite = await second.boss.call("POST", `/api/admin/venues/${second.bar.id}/invites`, { role: "staff" });
    const token = invite.body.link.split("/join/")[1];
    expect((await browser().call("POST", `/api/auth/invite/${token}`, { email: first.managerEmail, password: "not their password" })).status).toBe(401);
    const ok = await first.manager.call("POST", `/api/auth/invite/${token}`, { email: first.managerEmail, password: PASSWORD });
    expect(ok.status).toBe(200);
    const names = (await first.manager.call("GET", "/api/admin/venues")).body.map((x) => [x.name, x.role]);
    expect(names).toEqual([["First Bar", "manager"], ["Second Bar", "staff"]]);
  });

  it("can be cancelled, and expired ones don't work", async () => {
    const { boss, bar } = await barWithManager("Cancel Bar");
    const invite = await boss.call("POST", `/api/admin/venues/${bar.id}/invites`, { role: "staff" });
    const token = invite.body.link.split("/join/")[1];
    expect((await boss.call("DELETE", `/api/admin/venues/${bar.id}/invites/${invite.body.id}`)).status).toBe(204);
    expect((await browser().call("GET", `/api/auth/invite/${token}`)).status).toBe(404);

    const old = await boss.call("POST", `/api/admin/venues/${bar.id}/invites`, { role: "staff" });
    await env.DB.prepare("UPDATE invites SET expires_at = 1 WHERE id = ?").bind(old.body.id).run();
    expect((await browser().call("GET", `/api/auth/invite/${old.body.link.split("/join/")[1]}`)).status).toBe(410);
  });

  it("asks for a decent password", async () => {
    const { boss, bar } = await barWithManager("Password Bar");
    const invite = await boss.call("POST", `/api/admin/venues/${bar.id}/invites`, { role: "staff" });
    const token = invite.body.link.split("/join/")[1];
    expect((await browser().call("POST", `/api/auth/invite/${token}`, { email: "short@example.com", password: "short" })).status).toBe(400);
    expect((await browser().call("POST", `/api/auth/invite/${token}`, { email: "jonathan@example.com", password: "jonathan123456" })).status).toBe(400);
  });
});

describe("roles", () => {
  async function staffAt(bar, inviter) {
    const invite = await inviter.call("POST", `/api/admin/venues/${bar.id}/invites`, { role: "staff" });
    const b = browser();
    const email = `staff-${Math.random().toString(36).slice(2, 8)}@example.com`;
    await b.call("POST", `/api/auth/invite/${invite.body.link.split("/join/")[1]}`, { email, password: PASSWORD });
    return { b, email };
  }

  it("lets staff manage content but not people", async () => {
    const { bar, manager } = await barWithManager("Roles Bar");
    const { b } = await staffAt(bar, manager);
    expect((await b.call("POST", `/api/admin/venues/${bar.id}/menus`, { title: "Drinks", kind: "list", sections: [{ items: [{ name: "Beer" }] }] })).status).toBe(201);
    expect((await b.call("GET", `/api/admin/venues/${bar.id}/staff`)).status).toBe(403);
    expect((await b.call("POST", `/api/admin/venues/${bar.id}/invites`, { role: "staff" })).status).toBe(403);
  });

  it("lets managers handle staff but not other managers, and not invite managers", async () => {
    const { boss, bar, manager } = await barWithManager("Managers Bar");
    expect((await manager.call("POST", `/api/admin/venues/${bar.id}/invites`, { role: "manager" })).status).toBe(403);
    const { email } = await staffAt(bar, manager);
    const people = (await manager.call("GET", `/api/admin/venues/${bar.id}/staff`)).body.members;
    expect(people.map((p) => p.role).sort()).toEqual(["manager", "staff"]);

    const second = await boss.call("POST", `/api/admin/venues/${bar.id}/invites`, { role: "manager" });
    const m2 = browser();
    await m2.call("POST", `/api/auth/invite/${second.body.link.split("/join/")[1]}`, { email: "m2@example.com", password: PASSWORD });
    expect((await manager.call("DELETE", `/api/admin/venues/${bar.id}/staff/m2%40example.com`)).status).toBe(403);
    expect((await manager.call("DELETE", `/api/admin/venues/${bar.id}/staff/${encodeURIComponent(email)}`)).status).toBe(204);
  });
});

describe("password resets and changes", () => {
  it("resets through a one-time link, signing out everywhere", async () => {
    const { bar, manager } = await barWithManager("Reset Bar");
    const invite = await manager.call("POST", `/api/admin/venues/${bar.id}/invites`, { role: "staff" });
    const staff = browser();
    await staff.call("POST", `/api/auth/invite/${invite.body.link.split("/join/")[1]}`, { email: "forgetful@example.com", password: PASSWORD });

    const reset = await manager.call("POST", `/api/admin/venues/${bar.id}/staff/forgetful%40example.com/reset`);
    expect(reset.status).toBe(201);
    const token = reset.body.link.split("/reset/")[1];
    expect((await browser().call("GET", `/api/auth/reset/${token}`)).body.email).toBe("forgetful@example.com");
    const fresh = browser();
    expect((await fresh.call("POST", `/api/auth/reset/${token}`, { password: "a whole new password" })).status).toBe(200);
    expect((await staff.call("GET", "/api/admin/me")).status).toBe(401);
    expect((await fresh.call("GET", "/api/admin/me")).status).toBe(200);
    expect((await browser().call("POST", `/api/auth/reset/${token}`, { password: "again again again" })).status).toBe(404);
  });

  it("won't let a manager reset the owner, or someone from another bar", async () => {
    const a = await barWithManager("Bar A");
    const b = await barWithManager("Bar B");
    expect((await a.manager.call("POST", `/api/admin/venues/${a.bar.id}/staff/boss%40example.com/reset`)).status).toBe(404);
    expect((await a.manager.call("POST", `/api/admin/venues/${a.bar.id}/staff/${encodeURIComponent(b.managerEmail)}/reset`)).status).toBe(404);
  });

  it("changes your own password with the current one, signing out other sessions", async () => {
    const { managerEmail, manager } = await barWithManager("Change Bar");
    const elsewhere = browser();
    await elsewhere.call("POST", "/api/auth/login", { email: managerEmail, password: PASSWORD });
    expect((await manager.call("POST", "/api/admin/account/password", { current: "wrong wrong wrong", password: "another password 1" })).status).toBe(401);
    expect((await manager.call("POST", "/api/admin/account/password", { current: PASSWORD, password: "another password 1" })).status).toBe(200);
    expect((await manager.call("GET", "/api/admin/me")).status).toBe(200);
    expect((await elsewhere.call("GET", "/api/admin/me")).status).toBe(401);
  });
});
