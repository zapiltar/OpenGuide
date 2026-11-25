// OpenGuide Bar admin site. Plain DOM, no build step. Pages are chosen by the URL hash:
//   #/                         bars you can manage
//   #/new-bar                  add a bar (owner)
//   #/bar/<id>/<tab>[/<item>]  a bar's specials, menus, events, screens, settings or staff
//
// Every time shown or entered here is in the bar's own time zone, not the browser's.

import { localParts, occurrences, zonedTime } from "/shared/schedule.js";
import { PRESETS, deriveTheme } from "/shared/theme.js";

const app = document.getElementById("app");
let me = null;
let renderId = 0;

// ---------- small helpers ----------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = true;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

let toastTimer;
function toast(message, error = false) {
  const t = document.getElementById("toast");
  t.textContent = message;
  t.className = error ? "toast error" : "toast";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), error ? 6000 : 2500);
}

async function api(method, path, body, file) {
  const init = { method, headers: {}, credentials: "same-origin" };
  if (file) {
    init.body = file;
    init.headers["Content-Type"] = file.type;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
  }
  let res;
  try {
    res = await fetch(`/api/admin${path}`, init);
  } catch {
    // Cloudflare Access answers an expired sign-in with a redirect to its login page, which fetch can't follow.
    throw Object.assign(new Error("Couldn't reach the server. Your sign-in may have expired: reload the page."), { status: 0 });
  }
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

/** Runs [fn] while [button] shows it's busy, and reports errors. */
async function busy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

const go = (hash) => {
  if (location.hash === hash) render();
  else location.hash = hash;
};

// ---------- time formatting ----------

const pad = (n) => String(n).padStart(2, "0");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const dayName = (d, style = "short") =>
  new Intl.DateTimeFormat(undefined, { weekday: style, timeZone: "UTC" }).format(Date.UTC(2000, 0, 2 + d)); // 2 Jan 2000 was a Sunday

function clock(hhmm) {
  const [hh, mm] = hhmm.split(":").map(Number);
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(Date.UTC(2000, 0, 1, hh, mm));
}

function when(ms, tz) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(ms);
}

function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(ms);
}

function toInput(ms, tz) {
  if (ms === null || ms === undefined) return "";
  const p = localParts(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

function fromInput(value, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value || "");
  return m ? zonedTime(+m[1], +m[2], +m[3], +m[4], +m[5], tz) : null;
}

function scheduleText(s, tz) {
  if (s.type === "once") return `${when(s.start, tz)} to ${when(s.end, tz)}`;
  const days = new Set(s.days);
  let d;
  if (days.size === 7) d = "Every day";
  else if (days.size === 5 && [1, 2, 3, 4, 5].every((x) => days.has(x))) d = "Weekdays";
  else if (days.size === 2 && days.has(0) && days.has(6)) d = "Weekends";
  else d = DAY_ORDER.filter((x) => days.has(x)).map((x) => dayName(x)).join(", ");
  const overnight = s.end <= s.start ? " (next day)" : "";
  return `${d}, ${clock(s.start)} to ${clock(s.end)}${overnight}`;
}

/** "On now" or "Next: Fri 4:00 PM", from the same rules the TVs get. */
function specialStatus(special, tz) {
  if (!special.enabled) return { text: "Paused", cls: "" };
  const now = Date.now();
  const next = occurrences(special.schedule, tz, now, now + 15 * 86_400_000)[0];
  if (!next) return { text: special.schedule.type === "once" ? "Finished" : "Not scheduled", cls: "" };
  if (next.start <= now) return { text: "On now", cls: "ok" };
  return { text: `Next: ${when(next.start, tz)}`, cls: "warn" };
}

// ---------- shared form parts ----------

const field = (label, input, hint) => h("label", { class: "field" }, label, hint ? h("span", { class: "hint" }, hint) : null, input);

function imageField(venueId, key, url, { label = "Image", hint } = {}) {
  let current = key;
  const preview = h("div");
  const fileInput = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true });
  const removeBtn = h("button", { type: "button", class: "small" }, "Remove");
  const pickBtn = h("button", { type: "button", class: "small" }, "Upload image");

  function show(src) {
    preview.replaceChildren(src ? h("img", { src, alt: "" }) : h("div", { class: "placeholder" }, "No image"));
    removeBtn.hidden = !src;
    pickBtn.textContent = src ? "Change" : "Upload image";
  }
  show(url);
  pickBtn.addEventListener("click", () => fileInput.click());
  removeBtn.addEventListener("click", () => {
    current = null;
    show(null);
  });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return toast("Images must be 5 MB or smaller", true);
    pickBtn.disabled = true;
    pickBtn.textContent = "Uploading…";
    try {
      const res = await api("POST", `/venues/${venueId}/images`, undefined, file);
      current = res.key;
      show(res.url);
    } catch (e) {
      toast(e.message, true);
      show(current ? url : null);
    } finally {
      pickBtn.disabled = false;
    }
  });
  const el = h("div", { class: "field" },
    h("span", { style: "font-weight:600" }, label),
    hint ? h("span", { class: "hint" }, hint) : null,
    h("div", { class: "image-field" }, preview, h("div", { class: "row" }, pickBtn, removeBtn), fileInput),
  );
  return { el, value: () => current };
}

/**
 * A menu item's optional picture, shown beside it on the TV. It's kept on the item itself ([it].image and
 * [it].imageUrl), so redrawing the menu editor doesn't lose it.
 */
function itemPicture(venueId, it) {
  const fileInput = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true });
  const thumb = h("span");
  const pickBtn = h("button", { type: "button", class: "small" });
  const removeBtn = h("button", { type: "button", class: "small" }, "Remove picture");
  function show() {
    thumb.replaceChildren(...(it.imageUrl ? [h("img", { src: it.imageUrl, alt: "" })] : []));
    pickBtn.textContent = it.imageUrl ? "Change picture" : "Add picture";
    removeBtn.hidden = !it.imageUrl;
  }
  show();
  pickBtn.addEventListener("click", () => fileInput.click());
  removeBtn.addEventListener("click", () => {
    it.image = null;
    it.imageUrl = null;
    show();
  });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return toast("Images must be 5 MB or smaller", true);
    pickBtn.disabled = true;
    pickBtn.textContent = "Uploading…";
    try {
      const res = await api("POST", `/venues/${venueId}/images`, undefined, file);
      it.image = res.key;
      it.imageUrl = res.url;
    } catch (e) {
      toast(e.message, true);
    } finally {
      pickBtn.disabled = false;
      show();
    }
  });
  return h("div", { class: "item-picture" }, thumb, pickBtn, removeBtn, fileInput);
}

/** "All screens" or "Only these", for items that can be limited to some TVs. */
function screenPicker(screens, selected) {
  if (!screens.length) {
    return { el: h("p", { class: "hint" }, "Shows on every screen. Once TVs are linked, you can pick which ones."), value: () => null };
  }
  const name = `screens-${Math.random().toString(36).slice(2)}`;
  const all = h("input", { type: "radio", name, checked: !selected });
  const some = h("input", { type: "radio", name, checked: !!selected });
  const boxes = screens.map((s) => ({ id: s.id, input: h("input", { type: "checkbox", checked: selected?.includes(s.id) }), name: s.name }));
  const list = h("div", { class: "days" }, boxes.map((b) => h("label", null, b.input, b.name)));
  const sync = () => (list.hidden = !some.checked);
  all.addEventListener("change", sync);
  some.addEventListener("change", sync);
  sync();
  const el = h("fieldset", null, h("legend", null, "Screens"),
    h("div", { class: "choice" },
      h("label", null, all, "All screens"),
      h("label", null, some, "Only these screens")),
    list);
  return {
    el,
    value() {
      if (all.checked) return null;
      const ids = boxes.filter((b) => b.input.checked).map((b) => b.id);
      if (!ids.length) throw new Error("Pick at least one screen, or choose All screens");
      return ids;
    },
  };
}

function screensText(ids, screens) {
  if (!ids) return "All screens";
  const names = ids.map((id) => screens.find((s) => s.id === id)?.name).filter(Boolean);
  return names.length ? names.join(", ") : "No screens";
}

function thumb(url) {
  return url ? h("img", { class: "thumb", src: url, alt: "" }) : null;
}

// ---------- pages ----------

async function render() {
  const id = ++renderId;
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  try {
    let view;
    // Pages that work without signing in.
    if (parts[0] === "login") view = loginPage();
    else if (parts[0] === "setup") view = await setupPage();
    else if (parts[0] === "join" && parts[1]) view = await joinPage(parts[1]);
    else if (parts[0] === "reset" && parts[1]) view = await resetPage(parts[1]);
    if (view) {
      if (id !== renderId) return;
      app.replaceChildren(view);
      window.scrollTo(0, 0);
      return;
    }
    if (!me) signedIn(await api("GET", "/me"));
    if (parts[0] === "account") view = accountPage();
    else if (parts[0] === "new-bar") view = await newBarPage();
    else if (parts[0] === "bar" && parts[1]) view = await barPage(parts[1], parts[2] || "specials", parts[3]);
    else view = await homePage();
    if (id !== renderId || !view) return; // a newer page replaced this one while it loaded
    app.replaceChildren(view);
    window.scrollTo(0, 0);
  } catch (e) {
    if (id !== renderId) return;
    if (e.status === 401 && !["login", "setup", "join", "reset"].includes(parts[0])) {
      // Signed out, or the session ran out: sign in, then come back here.
      me = null;
      showWho();
      afterSignIn = location.hash || "#/";
      app.replaceChildren(loginPage());
      return;
    }
    app.replaceChildren(errorPage(e));
  }
}

function errorPage(e) {
  const title = e.status === 401 ? "You're not signed in" : e.status === 404 ? "Not found" : "Something went wrong";
  return h("div", { class: "card" }, h("h1", null, title), h("p", null, e.message),
    h("p", null, h("a", { href: "#/" }, "Back to your bars"), " · ", h("a", { href: location.href, onclick: () => location.reload() }, "Reload")));
}

async function homePage() {
  const venues = await api("GET", "/venues");
  if (!me.owner && venues.length === 1) {
    location.replace(`#/bar/${venues[0].id}/specials`);
    return null;
  }
  return h("div", null,
    h("div", { class: "row spread" },
      h("h1", null, "Your bars"),
      me.owner ? h("a", { class: "button primary", href: "#/new-bar" }, "Add a bar") : null),
    venues.length
      ? h("ul", { class: "list", style: "margin-top:16px" }, venues.map((v) =>
        h("li", null, h("a", { class: "card item item-link", href: `#/bar/${v.id}/specials` },
          thumb(v.logoUrl),
          h("div", { class: "body" }, h("h3", null, v.name), h("p", { class: "muted small" }, v.displayName ? `Shown on TVs as “${v.displayName}” · ${v.timezone}` : v.timezone))))))
      : h("div", { class: "card empty", style: "margin-top:16px" },
        me.owner ? "No bars yet. Add one to get started." : "You haven't been added to a bar yet. Ask the site owner to add your email."),
  );
}

function timeZoneSelect(value) {
  const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf("timeZone") : [value];
  if (value && !zones.includes(value)) zones.unshift(value);
  return h("select", { required: true }, zones.map((z) => h("option", { value: z, selected: z === value }, z.replace(/_/g, " "))));
}

async function newBarPage() {
  if (!me.owner) throw Object.assign(new Error("Only the site owner can add bars."), { status: 403 });
  const name = h("input", { type: "text", required: true, maxlength: 100 });
  const display = h("input", { type: "text", maxlength: 60 });
  const tz = timeZoneSelect(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const save = h("button", { class: "primary" }, "Add bar");
  const form = h("form", { class: "card" },
    field("Bar name", name),
    field("Name on TVs", display, "Optional. Shown on the TVs in place of OpenGuide. Leave empty to use the bar name."),
    field("Time zone", tz, "Specials and events run on this clock."),
    h("div", { class: "form-actions" }, save, h("a", { class: "button", href: "#/" }, "Cancel")));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    busy(save, async () => {
      const v = await api("POST", "/venues", { name: name.value, displayName: display.value, timezone: tz.value });
      toast("Bar added");
      go(`#/bar/${v.id}/staff`);
    });
  });
  return h("div", null, h("h1", null, "Add a bar"), h("p", { class: "muted" }, "Next you'll get an invite link for the bar's manager."), form);
}

const TABS = [
  ["specials", "Specials"],
  ["menus", "Menus"],
  ["events", "Events"],
  ["channel", "Bar Channel"],
  ["screens", "Screens"],
  ["settings", "Name & logo"],
  ["staff", "People", true],
];

async function barPage(venueId, tab, item) {
  const [venue, screens] = await Promise.all([api("GET", `/venues/${venueId}`), api("GET", `/venues/${venueId}/screens`)]);
  const ctx = { venue, screens, tz: venue.timezone, base: `#/bar/${venueId}` };
  const pages = { specials: [specialsList, specialEditor], menus: [menusList, menuEditor], events: [eventsList, eventEditor] };
  let body;
  if (pages[tab]) body = await (item ? pages[tab][1] : pages[tab][0])(ctx, item);
  else if (tab === "screens") body = screensPage(ctx);
  else if (tab === "channel") body = await channelPage(ctx);
  else if (tab === "settings") body = settingsPage(ctx);
  else if (tab === "staff" && (venue.role === "owner" || venue.role === "manager")) body = await staffPage(ctx);
  else throw Object.assign(new Error("That page doesn't exist."), { status: 404 });

  return h("div", null,
    h("div", { class: "bar-head" }, venue.logoUrl ? h("img", { src: venue.logoUrl, alt: "" }) : null,
      h("div", null, h("h1", null, venue.name), h("div", { class: "muted small" }, venue.timezone.replace(/_/g, " "))),
      sendToTvs(ctx)),
    h("nav", { class: "tabs", "aria-label": "Bar sections" },
      TABS.filter(([, , managersOnly]) => !managersOnly || venue.role === "owner" || venue.role === "manager").map(([key, label]) =>
        h("a", { href: `${ctx.base}/${key}`, "aria-current": key === tab ? "page" : null }, label))),
    body);
}

/**
 * "Send changes to TVs": changes saved on the site reach the TVs when this is pressed, or at the TVs' own
 * hourly check. It stands out when there are changes the TVs haven't got yet.
 */
function sendToTvs(ctx) {
  const v = ctx.venue;
  const waiting = v.feedVersion > v.pushedVersion;
  const button = h("button", { class: waiting ? "primary" : "" }, waiting ? "Send changes to TVs" : "Send to TVs again");
  button.addEventListener("click", () => busy(button, async () => {
    const { tvs } = await api("POST", `/venues/${v.id}/push`);
    toast(tvs
      ? `Sent to ${tvs} TV${tvs === 1 ? "" : "s"}. They update in a few seconds.`
      : "No TVs are on right now. They'll get the changes when they're next switched on.");
    render();
  }));
  return h("div", { class: "send-tvs" }, button,
    h("span", { class: "muted small" }, waiting ? "You have changes the TVs haven't got yet." : "The TVs are up to date."));
}

// ----- specials -----

async function specialsList(ctx) {
  const items = await api("GET", `/venues/${ctx.venue.id}/specials`);
  return h("div", null,
    h("div", { class: "row spread" },
      h("p", { class: "muted", style: "margin:0" }, "Pop up on the TVs while they're on."),
      h("a", { class: "button primary", href: `${ctx.base}/specials/new` }, "Add special")),
    items.length
      ? h("ul", { class: "list", style: "margin-top:16px" }, items.map((s) => {
        const status = specialStatus(s, ctx.tz);
        const toggle = h("button", { class: "small" }, s.enabled ? "Pause" : "Resume");
        toggle.addEventListener("click", (ev) => {
          ev.preventDefault();
          busy(toggle, async () => {
            await api("PUT", `/venues/${ctx.venue.id}/specials/${s.id}`, { ...s, enabled: !s.enabled });
            toast(s.enabled ? "Paused" : "Resumed");
            render();
          });
        });
        const timing = [
          s.display === "picture" ? "Full-screen picture" : s.display === "takeover" ? "Full screen" : "Banner",
          s.timeoutSeconds === null ? "until it ends" : `${s.timeoutSeconds} s each time`,
          s.repeatMinutes ? `every ${s.repeatMinutes} min` : "once",
          screensText(s.screens, ctx.screens),
        ].join(" · ");
        return h("li", null, h("a", { class: "card item item-link", href: `${ctx.base}/specials/${s.id}` },
          thumb(s.imageUrl),
          h("div", { class: "body" },
            h("h3", null, s.title, h("span", { class: `badge ${status.cls}` }, status.text)),
            h("p", { class: "small" }, scheduleText(s.schedule, ctx.tz)),
            h("p", { class: "muted small" }, timing)),
          h("div", { class: "actions" }, toggle)));
      }))
      : h("div", { class: "card empty", style: "margin-top:16px" }, "No specials yet. Add happy hour, game-day deals and more."));
}

async function specialEditor(ctx, itemId) {
  const isNew = itemId === "new";
  const s = isNew
    ? { title: "", text: "", image: null, imageUrl: null, display: "banner", timeoutSeconds: 30, repeatMinutes: null, enabled: true, screens: null,
      schedule: { type: "weekly", days: [1, 2, 3, 4, 5], start: "16:00", end: "19:00" } }
    : await api("GET", `/venues/${ctx.venue.id}/specials/${itemId}`);
  const tz = ctx.tz;

  const title = h("input", { type: "text", required: true, maxlength: 100, value: s.title });
  const text = h("textarea", { maxlength: 300 }, s.text || "");
  const image = imageField(ctx.venue.id, s.image, s.imageUrl, { hint: "Optional. Shown beside the text, or on its own for a full-screen picture." });

  // When
  const weekly = s.schedule.type === "weekly";
  const typeName = "sched-type";
  const typeWeekly = h("input", { type: "radio", name: typeName, checked: weekly });
  const typeOnce = h("input", { type: "radio", name: typeName, checked: !weekly });
  const days = DAY_ORDER.map((d) => ({ d, input: h("input", { type: "checkbox", checked: weekly && s.schedule.days.includes(d) }) }));
  const wStart = h("input", { type: "time", value: weekly ? s.schedule.start : "16:00", required: true });
  const wEnd = h("input", { type: "time", value: weekly ? s.schedule.end : "19:00", required: true });
  const oStart = h("input", { type: "datetime-local", value: weekly ? "" : toInput(s.schedule.start, tz) });
  const oEnd = h("input", { type: "datetime-local", value: weekly ? "" : toInput(s.schedule.end, tz) });
  const weeklyBox = h("div", { style: "display:grid;gap:10px" },
    h("div", { class: "days" }, days.map(({ d, input }) => h("label", null, input, dayName(d)))),
    h("div", { class: "row" }, h("label", { class: "field" }, "From", wStart), h("label", { class: "field" }, "Until", wEnd)),
    h("p", { class: "hint", style: "margin:0" }, "If “until” is earlier than “from”, it runs past midnight."));
  const onceBox = h("div", { class: "row" }, h("label", { class: "field" }, "Starts", oStart), h("label", { class: "field" }, "Ends", oEnd));
  const syncType = () => {
    weeklyBox.hidden = !typeWeekly.checked;
    onceBox.hidden = !typeOnce.checked;
  };
  typeWeekly.addEventListener("change", syncType);
  typeOnce.addEventListener("change", syncType);
  syncType();

  // How it appears
  const dispName = "display";
  const banner = h("input", { type: "radio", name: dispName, checked: s.display === "banner" });
  const takeover = h("input", { type: "radio", name: dispName, checked: s.display === "takeover" });
  const picture = h("input", { type: "radio", name: dispName, checked: s.display === "picture" });
  const seconds = h("input", { type: "number", min: 5, max: 600, step: 1, value: s.timeoutSeconds ?? 30 });
  const untilEnd = h("input", { type: "checkbox", checked: s.timeoutSeconds === null && s.display === "banner" });
  const untilEndLabel = h("label", { class: "check" }, untilEnd, "Keep it up until the special ends");
  let secondsTouched = !isNew;
  seconds.addEventListener("input", () => (secondsTouched = true));
  const syncDisplay = () => {
    untilEndLabel.hidden = !banner.checked;
    if (!banner.checked) untilEnd.checked = false;
    seconds.disabled = untilEnd.checked;
    if (!secondsTouched) seconds.value = banner.checked ? 30 : 15;
  };
  [banner, takeover, picture, untilEnd].forEach((x) => x.addEventListener("change", syncDisplay));
  syncDisplay();

  const repeat = h("input", { type: "checkbox", checked: s.repeatMinutes !== null });
  const repeatMin = h("input", { type: "number", min: 1, max: 1440, value: s.repeatMinutes ?? 20 });
  const syncRepeat = () => (repeatMin.disabled = !repeat.checked);
  repeat.addEventListener("change", syncRepeat);
  syncRepeat();

  const screens = screenPicker(ctx.screens, s.screens);
  const enabled = h("input", { type: "checkbox", checked: s.enabled });

  const save = h("button", { class: "primary" }, isNew ? "Add special" : "Save");
  const del = isNew ? null : h("button", { type: "button", class: "danger" }, "Delete");
  const form = h("form", { class: "card" },
    field("Title", title, "Big and short, like “Happy Hour” or “$5 Wings”."),
    field("Details", text, "Optional. One or two lines."),
    image.el,
    h("fieldset", null, h("legend", null, "When"),
      h("div", { class: "choice" }, h("label", null, typeWeekly, "Every week"), h("label", null, typeOnce, "One time")),
      weeklyBox, onceBox,
      h("p", { class: "hint", style: "margin:0" }, `Times are in the bar's time zone (${tz.replace(/_/g, " ")}).`)),
    h("fieldset", null, h("legend", null, "On the TV"),
      h("div", { class: "choice" },
        h("label", null, banner, h("span", null, h("strong", null, "Banner"), h("span", { class: "hint" }, "Slides in along the top. The game stays visible."))),
        h("label", null, takeover, h("span", null, h("strong", null, "Full screen"), h("span", { class: "hint" }, "Covers the picture, then goes back to the channel. Up to 10 minutes."))),
        h("label", null, picture, h("span", null, h("strong", null, "Full-screen picture"), h("span", { class: "hint" }, "Just your uploaded image, filling the screen, like a poster. Landscape (16:9) fits a TV best.")))),
      h("div", { class: "row" }, h("span", null, "Stays up for"), seconds, h("span", null, "seconds each time")),
      untilEndLabel,
      h("label", { class: "check" }, repeat, "Show it again while the special is on, every", repeatMin, "minutes")),
    screens.el,
    h("label", { class: "check" }, enabled, "Active (untick to pause without deleting)"),
    h("div", { class: "form-actions" }, h("div", { class: "row" }, save, h("a", { class: "button", href: `${ctx.base}/specials` }, "Cancel")), del));

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    busy(save, async () => {
      let schedule;
      if (typeWeekly.checked) {
        schedule = { type: "weekly", days: days.filter((x) => x.input.checked).map((x) => x.d), start: wStart.value, end: wEnd.value };
        if (!schedule.days.length) throw new Error("Pick at least one day");
      } else {
        schedule = { type: "once", start: fromInput(oStart.value, tz), end: fromInput(oEnd.value, tz) };
        if (!schedule.start || !schedule.end) throw new Error("Enter when it starts and ends");
      }
      if (picture.checked && !image.value()) throw new Error("Upload the picture to show full screen");
      const body = {
        title: title.value,
        text: text.value,
        image: image.value(),
        schedule,
        display: banner.checked ? "banner" : picture.checked ? "picture" : "takeover",
        timeoutSeconds: untilEnd.checked ? null : Number(seconds.value),
        repeatMinutes: repeat.checked ? Number(repeatMin.value) : null,
        enabled: enabled.checked,
        screens: screens.value(),
      };
      await (isNew
        ? api("POST", `/venues/${ctx.venue.id}/specials`, body)
        : api("PUT", `/venues/${ctx.venue.id}/specials/${itemId}`, body));
      toast("Saved. Send it to the TVs when you're ready.");
      go(`${ctx.base}/specials`);
    });
  });
  del?.addEventListener("click", () => deleteItem(del, ctx, "specials", itemId, s.title));
  return h("div", null, h("h2", { style: "margin-top:0" }, isNew ? "New special" : "Edit special"), form);
}

function deleteItem(button, ctx, kind, itemId, title) {
  if (!confirm(`Delete “${title}”? This can't be undone.`)) return;
  busy(button, async () => {
    await api("DELETE", `/venues/${ctx.venue.id}/${kind}/${itemId}`);
    toast("Deleted");
    go(`${ctx.base}/${kind}`);
  });
}

// ----- menus -----

async function menusList(ctx) {
  const items = await api("GET", `/venues/${ctx.venue.id}/menus`);
  return h("div", null,
    h("div", { class: "row spread" },
      h("p", { class: "muted", style: "margin:0" }, "Shown on the Bar Channel, one after another."),
      h("a", { class: "button primary", href: `${ctx.base}/menus/new` }, "Add menu")),
    items.length
      ? h("ul", { class: "list", style: "margin-top:16px" }, items.map((m) =>
        h("li", null, h("a", { class: "card item item-link", href: `${ctx.base}/menus/${m.id}` },
          thumb(m.imageUrl),
          h("div", { class: "body" },
            h("h3", null, m.title),
            h("p", { class: "muted small" }, [
              m.kind === "image" ? "Picture" : plural(m.sections.reduce((n, s) => n + s.items.length, 0), "item"),
              screensText(m.screens, ctx.screens),
            ].join(" · ")))))))
      : h("div", { class: "card empty", style: "margin-top:16px" }, "No menus yet. Upload a picture of one, or type it in."));
}

async function menuEditor(ctx, itemId) {
  const isNew = itemId === "new";
  const m = isNew
    ? { title: "", kind: "list", image: null, imageUrl: null, sections: [{ title: "", items: [{ name: "", price: "", description: "" }] }], sort: 0, screens: null }
    : await api("GET", `/venues/${ctx.venue.id}/menus/${itemId}`);
  const sections = structuredClone(m.sections || [{ title: "", items: [{ name: "", price: "", description: "" }] }]);

  const title = h("input", { type: "text", required: true, maxlength: 100, value: m.title });
  const kindName = "menu-kind";
  const kindList = h("input", { type: "radio", name: kindName, checked: m.kind === "list" });
  const kindImage = h("input", { type: "radio", name: kindName, checked: m.kind === "image" });
  const image = imageField(ctx.venue.id, m.image, m.imageUrl, { label: "Menu picture", hint: "A photo or design of the menu. Landscape fits a TV best." });
  const sort = h("input", { type: "number", min: -1000, max: 1000, value: m.sort });
  const screens = screenPicker(ctx.screens, m.screens);

  const sectionsBox = h("div", { style: "display:grid;gap:14px" });
  function drawSections() {
    sectionsBox.replaceChildren(
      ...sections.map((sec, si) => h("fieldset", { class: "section-edit" },
        h("legend", null, `Section ${si + 1}`),
        h("input", { type: "text", placeholder: "Section title, like Beer or Starters (optional)", maxlength: 100, value: sec.title || "",
          oninput: (e) => (sec.title = e.target.value) }),
        ...sec.items.map((it, ii) => h("div", { class: "menu-item" },
          h("input", { type: "text", placeholder: "Item", maxlength: 100, value: it.name || "", "aria-label": "Item name", oninput: (e) => (it.name = e.target.value) }),
          h("input", { type: "text", placeholder: "Price", maxlength: 20, value: it.price || "", "aria-label": "Price", oninput: (e) => (it.price = e.target.value) }),
          h("button", { type: "button", class: "small", "aria-label": "Remove item",
            onclick: () => { sec.items.splice(ii, 1); drawSections(); } }, "✕"),
          h("textarea", { placeholder: "Description (optional)", maxlength: 300, "aria-label": "Description", oninput: (e) => (it.description = e.target.value) }, it.description || ""),
          itemPicture(ctx.venue.id, it))),
        h("div", { class: "row" },
          h("button", { type: "button", class: "small", onclick: () => { sec.items.push({ name: "", price: "", description: "" }); drawSections(); } }, "Add item"),
          sections.length > 1
            ? h("button", { type: "button", class: "small danger", onclick: () => { sections.splice(si, 1); drawSections(); } }, "Remove section")
            : null))),
      h("div", null, h("button", { type: "button", onclick: () => { sections.push({ title: "", items: [{ name: "", price: "", description: "" }] }); drawSections(); } }, "Add section")));
  }
  drawSections();
  const syncKind = () => {
    sectionsBox.hidden = !kindList.checked;
    image.el.hidden = !kindImage.checked;
  };
  kindList.addEventListener("change", syncKind);
  kindImage.addEventListener("change", syncKind);
  syncKind();

  const save = h("button", { class: "primary" }, isNew ? "Add menu" : "Save");
  const del = isNew ? null : h("button", { type: "button", class: "danger" }, "Delete");
  const form = h("form", { class: "card" },
    field("Title", title, "Like “Drinks” or “Food”."),
    h("div", { class: "choice" }, h("label", null, kindList, "Type the items in"), h("label", null, kindImage, "Upload a picture of the menu")),
    sectionsBox,
    image.el,
    field("Order", sort, "Menus with lower numbers show first."),
    screens.el,
    h("div", { class: "form-actions" }, h("div", { class: "row" }, save, h("a", { class: "button", href: `${ctx.base}/menus` }, "Cancel")), del));

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    busy(save, async () => {
      const list = kindList.checked;
      const cleaned = sections
        .map((sec) => ({ title: sec.title, items: sec.items.filter((it) => (it.name || "").trim()) }))
        .filter((sec) => sec.items.length);
      if (list && !cleaned.length) throw new Error("Add at least one item");
      if (!list && !image.value()) throw new Error("Upload a picture of the menu");
      const body = {
        title: title.value,
        kind: list ? "list" : "image",
        image: list ? null : image.value(),
        sections: list ? cleaned : null,
        sort: Number(sort.value) || 0,
        screens: screens.value(),
      };
      await (isNew ? api("POST", `/venues/${ctx.venue.id}/menus`, body) : api("PUT", `/venues/${ctx.venue.id}/menus/${itemId}`, body));
      toast("Saved");
      go(`${ctx.base}/menus`);
    });
  });
  del?.addEventListener("click", () => deleteItem(del, ctx, "menus", itemId, m.title));
  return h("div", null, h("h2", { style: "margin-top:0" }, isNew ? "New menu" : "Edit menu"), form);
}

// ----- events -----

/** "Every Tuesday, 8:00 PM to 10:00 PM, until Mar 1" */
function repeatText(r) {
  const days = new Set(r.days);
  let d;
  if (days.size === 7) d = "Every day";
  else if (days.size === 5 && [1, 2, 3, 4, 5].every((x) => days.has(x))) d = "Weekdays";
  else if (days.size === 2 && days.has(0) && days.has(6)) d = "Weekends";
  else if (days.size === 1) d = `Every ${dayName(r.days[0], "long")}`;
  else d = "Every " + DAY_ORDER.filter((x) => days.has(x)).map((x) => dayName(x)).join(", ");
  const time = r.end ? `${clock(r.start)} to ${clock(r.end)}${r.end <= r.start ? " (next day)" : ""}` : clock(r.start);
  return `${d}, ${time}` + (r.until ? `, until ${dateText(r.until)}` : "");
}

/** A "YYYY-MM-DD" date as "Mar 1" (or "Mar 1, 2027" when it isn't this year). */
function dateText(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const opts = { month: "short", day: "numeric", timeZone: "UTC", ...(y !== new Date().getFullYear() ? { year: "numeric" } : {}) };
  return new Intl.DateTimeFormat(undefined, opts).format(Date.UTC(y, m - 1, d));
}

/** Today's date in the bar's time zone, as "YYYY-MM-DD". */
function todayIn(tz) {
  const p = localParts(Date.now(), tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** A repeating event's next start, the way the TVs work it out, or null if it has finished. */
function nextRepeat(e, tz) {
  const r = e.repeat;
  const [h, m] = r.start.split(":").map(Number);
  const end = r.end ?? `${pad(Math.floor((h * 60 + m + 1) / 60) % 24)}:${pad((m + 1) % 60)}`;
  const now = Date.now();
  const from = Math.max(now, e.start);
  const to = Math.min(now + 15 * 86_400_000, e.end ?? Infinity);
  if (from >= to) return null;
  const o = occurrences({ type: "weekly", days: r.days, start: r.start, end }, tz, from, to)
    .find((x) => x.start >= e.start && (e.end === null || x.start < e.end));
  return o ? o.start : null;
}

async function eventsList(ctx) {
  const items = await api("GET", `/venues/${ctx.venue.id}/events`);
  const now = Date.now();
  const finished = (e) => (e.repeat ? e.end !== null && e.end <= now : (e.end ?? e.start) < now);
  const upcoming = items.filter((e) => !finished(e)).sort((a, b) => (a.repeat ? 0 : a.start) - (b.repeat ? 0 : b.start));
  const past = items.filter(finished).reverse().slice(0, 10);
  const row = (e) => {
    let detail;
    let badge = null;
    if (e.repeat) {
      const next = nextRepeat(e, ctx.tz);
      detail = repeatText(e.repeat);
      badge = h("span", { class: "badge" }, e.start > now ? `Starts ${dateText(e.repeat.from)}` : next ? `Next: ${when(next, ctx.tz)}` : "Repeats");
    } else {
      detail = e.end ? `${when(e.start, ctx.tz)} to ${when(e.end, ctx.tz)}` : when(e.start, ctx.tz);
      if (e.start <= now && (e.end ?? e.start) >= now) badge = h("span", { class: "badge ok" }, "On now");
    }
    return h("li", null, h("a", { class: "card item item-link", href: `${ctx.base}/events/${e.id}` },
      thumb(e.imageUrl),
      h("div", { class: "body" },
        h("h3", null, e.title, badge),
        h("p", { class: "small" }, detail),
        h("p", { class: "muted small" }, screensText(e.screens, ctx.screens)))));
  };
  return h("div", null,
    h("div", { class: "row spread" },
      h("p", { class: "muted", style: "margin:0" }, "Upcoming events show on the Bar Channel."),
      h("a", { class: "button primary", href: `${ctx.base}/events/new` }, "Add event")),
    upcoming.length
      ? h("ul", { class: "list", style: "margin-top:16px" }, upcoming.map(row))
      : h("div", { class: "card empty", style: "margin-top:16px" }, "No upcoming events. Add trivia nights, big games and live music."),
    past.length ? [h("h2", null, "Past"), h("ul", { class: "list", style: "opacity:.7" }, past.map(row))] : null);
}

async function eventEditor(ctx, itemId) {
  const isNew = itemId === "new";
  const e = isNew
    ? { title: "", description: "", image: null, imageUrl: null, fullScreen: false, start: null, end: null, repeat: null, screens: null }
    : await api("GET", `/venues/${ctx.venue.id}/events/${itemId}`);
  const tz = ctx.tz;
  const r = e.repeat;
  const title = h("input", { type: "text", required: true, maxlength: 100, value: e.title });
  const desc = h("textarea", { maxlength: 1000 }, e.description || "");
  const image = imageField(ctx.venue.id, e.image, e.imageUrl, { hint: "Optional. A poster or photo." });
  const fullScreen = h("input", { type: "checkbox", checked: e.fullScreen });
  const fullScreenLabel = h("label", { class: "check" }, fullScreen,
    h("span", null, "Show the picture full screen on the Bar Channel ", h("span", { class: "hint" }, "Just your picture, edge to edge, with no text. Landscape (16:9) fits a TV best.")));

  const typeOnce = h("input", { type: "radio", name: "event-when", checked: !r });
  const typeWeekly = h("input", { type: "radio", name: "event-when", checked: !!r });

  const start = h("input", { type: "datetime-local", value: r ? "" : toInput(e.start, tz) });
  const end = h("input", { type: "datetime-local", value: r ? "" : toInput(e.end, tz) });
  const onceBox = h("div", { class: "row" }, field("Starts", start), field("Ends", end, "Optional"));

  const days = DAY_ORDER.map((d) => ({ d, input: h("input", { type: "checkbox", checked: r?.days.includes(d) }) }));
  const wStart = h("input", { type: "time", value: r?.start ?? "20:00" });
  const wEnd = h("input", { type: "time", value: r?.end ?? "" });
  const from = h("input", { type: "date", value: r?.from ?? todayIn(tz) });
  const until = h("input", { type: "date", value: r?.until ?? "" });
  const weeklyBox = h("div", { style: "display:grid;gap:10px" },
    h("div", { class: "days" }, days.map(({ d, input }) => h("label", null, input, dayName(d)))),
    h("div", { class: "row" }, field("From", wStart), field("Until", wEnd, "Optional")),
    h("div", { class: "row" }, field("Starting", from), field("Last date", until, "Optional. Leave empty to keep repeating.")));

  const sync = () => {
    onceBox.hidden = !typeOnce.checked;
    weeklyBox.hidden = !typeWeekly.checked;
  };
  typeOnce.addEventListener("change", sync);
  typeWeekly.addEventListener("change", sync);
  sync();

  const screens = screenPicker(ctx.screens, e.screens);
  const save = h("button", { class: "primary" }, isNew ? "Add event" : "Save");
  const del = isNew ? null : h("button", { type: "button", class: "danger" }, "Delete");
  const form = h("form", { class: "card" },
    field("Title", title),
    field("Details", desc, "Optional."),
    image.el,
    fullScreenLabel,
    h("fieldset", null, h("legend", null, "When"),
      h("div", { class: "choice" }, h("label", null, typeOnce, "One time"), h("label", null, typeWeekly, "Repeats every week")),
      onceBox, weeklyBox,
      h("p", { class: "hint", style: "margin:0" }, `Times are in the bar's time zone (${tz.replace(/_/g, " ")}).`)),
    screens.el,
    h("div", { class: "form-actions" }, h("div", { class: "row" }, save, h("a", { class: "button", href: `${ctx.base}/events` }, "Cancel")), del));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    busy(save, async () => {
      const body = { title: title.value, description: desc.value, image: image.value(), fullScreen: fullScreen.checked, screens: screens.value() };
      if (body.fullScreen && !body.image) throw new Error("Upload a picture to show it full screen");
      if (typeWeekly.checked) {
        body.repeat = {
          days: days.filter((x) => x.input.checked).map((x) => x.d),
          start: wStart.value,
          end: wEnd.value || null,
          from: from.value,
          until: until.value || null,
        };
        if (!body.repeat.days.length) throw new Error("Pick at least one day");
        if (!body.repeat.start) throw new Error("Enter what time it starts");
        if (!body.repeat.from) throw new Error("Enter the first date it happens");
      } else {
        body.start = fromInput(start.value, tz);
        body.end = fromInput(end.value, tz);
        if (!body.start) throw new Error("Enter when it starts");
      }
      await (isNew ? api("POST", `/venues/${ctx.venue.id}/events`, body) : api("PUT", `/venues/${ctx.venue.id}/events/${itemId}`, body));
      toast("Saved. Send it to the TVs when you're ready.");
      go(`${ctx.base}/events`);
    });
  });
  del?.addEventListener("click", () => deleteItem(del, ctx, "events", itemId, e.title));
  return h("div", null, h("h2", { style: "margin-top:0" }, isNew ? "New event" : "Edit event"), form);
}

// ----- the Bar Channel -----

/**
 * What the bar's own channel shows, for all of its TVs. The preview lists the pages in the order the TVs show
 * them, worked out the same way as on the TV, as things stand right now.
 */
async function channelPage(ctx) {
  const v = ctx.venue;
  const c = v.channel;
  const [menus, specials, events] = await Promise.all([
    api("GET", `/venues/${v.id}/menus`),
    api("GET", `/venues/${v.id}/specials`),
    api("GET", `/venues/${v.id}/events`),
  ]);

  const box = (checked) => h("input", { type: "checkbox", checked });
  const enabled = box(c.enabled);
  const onNow = box(c.onNow);
  const later = box(c.later);
  const eventsList = box(c.events);
  const posters = box(c.posters);
  const menuBoxes = menus.map((m) => ({ m, input: box(!c.hiddenMenus.includes(m.id)) }));
  const seconds = h("select", { style: "width:auto" },
    [8, 12, 20, 30].map((s) => h("option", { value: s, selected: s === c.seconds }, `${s} seconds`)));

  const option = (input, title, hint) =>
    h("label", { class: "check" }, input, h("span", null, h("strong", null, title), " ", h("span", { class: "hint" }, hint)));

  const parts = h("fieldset", null, h("legend", null, "What it shows, in this order"),
    option(onNow, "Specials on now", "A big page for each one, like Happy Hour."),
    option(later, "Later today's specials", "One list of what's coming up today."),
    menus.length
      ? h("div", { style: "display:grid;gap:8px" }, h("strong", null, "Menus"),
        h("div", { class: "days" }, menuBoxes.map(({ m, input }) => h("label", null, input, m.title))),
        h("span", { class: "hint" }, "New menus show here, ticked, until you untick them."))
      : h("p", { class: "hint", style: "margin:0" }, "Menus: none yet. Add them on the Menus tab."),
    option(eventsList, "Coming up", "A list of the next few events."),
    option(posters, "Event posters", "A page for each upcoming event with a picture."));

  const preview = h("ol", { class: "page-preview" });

  function drawPreview() {
    parts.disabled = !enabled.checked;
    seconds.disabled = !enabled.checked;
    if (!enabled.checked) {
      preview.replaceChildren(h("li", { class: "muted" }, "The Bar Channel is off, so it isn't in the TVs' guide."));
      return;
    }
    const now = Date.now();
    const pages = [];
    const today = specials
      .filter((s) => s.enabled)
      .map((s) => ({ s, o: occurrences(s.schedule, ctx.tz, now, now + 86_400_000)[0] }))
      .filter((x) => x.o);
    if (onNow.checked) today.filter((x) => x.o.start <= now).forEach((x) => pages.push(`On now: ${x.s.title}`));
    const laterToday = today.filter((x) => x.o.start > now);
    if (later.checked && laterToday.length) pages.push(`Later today: ${laterToday.map((x) => x.s.title).join(", ")}`);
    menuBoxes.filter((x) => x.input.checked).forEach((x) => pages.push(`Menu: ${x.m.title}`));
    const upcoming = events.filter((e) => (e.repeat ? nextRepeat(e, ctx.tz) !== null : (e.end ?? e.start) >= now));
    if (eventsList.checked && upcoming.length) pages.push(`Coming up: ${upcoming.slice(0, 6).map((e) => e.title).join(", ")}`);
    if (posters.checked) upcoming.filter((e) => e.image).forEach((e) => pages.push(`Poster: ${e.title}${e.fullScreen ? " (full screen)" : ""}`));
    if (!pages.length) pages.push("A welcome page, until there's something to show");
    preview.replaceChildren(...pages.map((p) => h("li", null, p)));
    const loop = pages.length * Number(seconds.value);
    preview.append(h("li", { class: "muted", style: "list-style:none;margin-left:-20px" },
      `Then it starts again: ${loop < 60 ? `${loop} seconds` : `about ${Math.round(loop / 60)} minute${Math.round(loop / 60) === 1 ? "" : "s"}`} all the way round.`));
  }
  [enabled, onNow, later, eventsList, posters, seconds, ...menuBoxes.map((x) => x.input)].forEach((el) => el.addEventListener("change", drawPreview));
  drawPreview();

  const save = h("button", { class: "primary" }, "Save");
  const form = h("form", { class: "card" },
    h("p", { class: "muted", style: "margin:0" },
      `${v.displayName || v.name}'s own channel, at the top of the TVs' guide. These settings are for all of the bar's TVs.`),
    option(enabled, "Show the Bar Channel on the TVs", "Turn it off to keep it out of the guide."),
    parts,
    h("label", { class: "row", style: "font-weight:600" }, "Each page stays up for", seconds),
    h("div", null, h("strong", null, "Right now, the TVs would show:"), preview),
    h("div", null, save));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    busy(save, async () => {
      await api("PATCH", `/venues/${v.id}`, {
        channel: {
          enabled: enabled.checked,
          onNow: onNow.checked,
          later: later.checked,
          events: eventsList.checked,
          posters: posters.checked,
          hiddenMenus: menuBoxes.filter((x) => !x.input.checked).map((x) => x.m.id),
          seconds: Number(seconds.value),
        },
      });
      toast("Saved. Send it to the TVs when you're ready.");
      render();
    });
  });
  // Bingo is its own channel, so it has its own switch, saved as soon as it's changed.
  const bingoOn = box(v.bingo);
  bingoOn.addEventListener("change", async () => {
    try {
      await api("PATCH", `/venues/${v.id}`, { bingo: bingoOn.checked });
      v.bingo = bingoOn.checked;
      toast(bingoOn.checked ? "Bingo is on. Send it to the TVs when you're ready." : "Bingo is off. Send it to the TVs when you're ready.");
      render();
    } catch (e) {
      toast(e.message, true);
      bingoOn.checked = v.bingo;
    }
  });
  const bingoCard = h("div", { class: "card", style: "margin-top:16px" },
    h("h2", { style: "margin:0" }, "Bingo"),
    option(bingoOn, "Show the Bingo channel on the TVs", "A 75-ball board showing every number called, the same on every TV that's showing it."),
    h("p", { class: "hint", style: "margin:0" },
      "To run a game, tune any TV to Bingo, hold OK and choose “Host bingo on this TV”. Then press OK on that TV's remote to call each number. ",
      "Hold OK again to take back a number or start a new game. Another TV can take over hosting the same way."));
  return h("div", null, form, bingoCard);
}

// ----- screens -----

/** How a screen shows channels, as the site and the TV name them. */
const LAYOUT_NAMES = { full: "Full picture", framed: "Framed with bar info", specials: "Framed during specials" };

function screensPage(ctx) {
  const code = h("input", { type: "text", class: "code-input", required: true, maxlength: 7, placeholder: "ABC-123", autocomplete: "off", autocapitalize: "characters", spellcheck: "false" });
  const name = h("input", { type: "text", required: true, maxlength: 60, placeholder: "Bar left" });
  const link = h("button", { class: "primary" }, "Link TV");
  const form = h("form", { class: "card" },
    h("h3", null, "Link a TV"),
    h("p", { class: "muted", style: "margin:0" }, "On the TV, open OpenGuide's Settings, then Bar mode, then Link to a bar. Type the code it shows here."),
    h("div", { class: "row" }, field("Code", code), field("Name this screen", name)),
    h("div", null, link));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    busy(link, async () => {
      await api("POST", `/venues/${ctx.venue.id}/screens`, { code: code.value, name: name.value });
      toast("Linked. The TV will finish in a few seconds.");
      render();
    });
  });

  const now = Date.now();
  const list = ctx.screens.map((s) => {
    let status;
    if (!s.linked) status = h("span", { class: "badge warn" }, "Finishing linking");
    else if (s.online) status = h("span", { class: "badge ok" }, "Online");
    else status = h("span", { class: "badge" }, s.lastSeen ? `Last seen ${ago(s.lastSeen)}` : "Not seen yet");
    const layout = h("select", { "aria-label": `Picture on ${s.name}` },
      Object.entries(LAYOUT_NAMES).map(([value, name]) => h("option", { value, selected: (s.layout in LAYOUT_NAMES ? s.layout : "full") === value }, name)));
    layout.addEventListener("change", async () => {
      try {
        await api("PATCH", `/venues/${ctx.venue.id}/screens/${s.id}`, { layout: layout.value });
        s.layout = layout.value;
        toast(`${LAYOUT_NAMES[layout.value]}. Send it to the TVs to switch it now.`);
        render();
      } catch (e) {
        toast(e.message, true);
        layout.value = s.layout;
      }
    });
    const rename = h("button", { class: "small" }, "Rename");
    const unlink = h("button", { class: "small danger" }, "Unlink");
    rename.addEventListener("click", () => {
      const next = prompt("New name for this screen", s.name);
      if (!next || next === s.name) return;
      busy(rename, async () => {
        await api("PATCH", `/venues/${ctx.venue.id}/screens/${s.id}`, { name: next });
        render();
      });
    });
    unlink.addEventListener("click", () => {
      if (!confirm(`Unlink “${s.name}”? If it's on, it goes back to plain OpenGuide straight away; otherwise the next time it's switched on.`)) return;
      busy(unlink, async () => {
        await api("DELETE", `/venues/${ctx.venue.id}/screens/${s.id}`);
        toast("Unlinked");
        render();
      });
    });
    return h("li", { class: "card item" },
      h("div", { class: "body" }, h("h3", null, s.name, status), s.appVersion ? h("p", { class: "muted small" }, `OpenGuide ${s.appVersion}`) : null,
        h("label", { class: "layout-pick" }, "Picture: ", layout)),
      h("div", { class: "actions" }, rename, unlink));
  });
  return h("div", null, form,
    h("h2", null, "Screens"),
    h("p", { class: "muted small", style: "margin-top:-4px" },
      "“Framed” shrinks the channel to the top right, with your logo and upcoming events down the left and the current special along the bottom. Framed screens show specials only in that bottom bar, never as banners or full-screen takeovers. “Framed during specials” shows the full picture, and frames it only while a special like happy hour is on."),
    list.length ? h("ul", { class: "list" }, list) : h("div", { class: "card empty" }, "No TVs linked yet."));
}

// ----- name, logo and time zone -----

function settingsPage(ctx) {
  const v = ctx.venue;
  const name = me.owner ? h("input", { type: "text", required: true, maxlength: 100, value: v.name }) : null;
  const display = h("input", { type: "text", maxlength: 60, value: v.displayName || "", placeholder: v.name });
  const logo = imageField(v.id, v.logo, v.logoUrl, { label: "Logo", hint: "Shown on the TVs in place of OpenGuide's. A square PNG with a clear background works best." });
  const tz = timeZoneSelect(v.timezone);
  const zip = h("input", { type: "text", inputmode: "numeric", pattern: "\\d{5}", maxlength: 5, value: v.weatherZip || "", placeholder: "Like 10001", style: "max-width:10em" });
  const colors = colorPicker(v.theme, () => display.value || v.displayName || v.name);
  const save = h("button", { class: "primary" }, "Save");
  const form = h("form", { class: "card" },
    name ? field("Bar name", name, "Only you, the site owner, can change this.") : null,
    field("Name on TVs", display, "Shown on the TVs in place of OpenGuide. Leave empty to use the bar name."),
    logo.el,
    colors.el,
    field("Time zone", tz, "Specials and events run on this clock."),
    field("ZIP code for the weather", zip, v.weatherPlace
      ? `Framed screens show the weather for ${v.weatherPlace}. Leave empty to use where each TV's internet connection says it is.`
      : "Framed screens show the temperature next to the clock. Without a US ZIP code, it's for where each TV's internet connection says it is. Weather from MET Norway."),
    h("div", null, save));
  display.addEventListener("input", colors.redraw);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    busy(save, async () => {
      const body = { displayName: display.value, logo: logo.value(), timezone: tz.value, theme: colors.value(), weatherZip: zip.value.trim() };
      if (name) body.name = name.value;
      await api("PATCH", `/venues/${v.id}`, body);
      toast("Saved. Send it to the TVs when you're ready.");
      render();
    });
  });
  if (!me.owner) return form;
  const del = h("button", { type: "button", class: "danger" }, "Delete this bar");
  del.addEventListener("click", () => {
    const typed = prompt(`This deletes ${v.name}, its menus, events, specials and images, and unlinks its TVs. It can't be undone.\n\nType the bar's name to confirm.`);
    if (typed === null) return;
    if (typed.trim() !== v.name) return toast("The name didn't match, so nothing was deleted", true);
    busy(del, async () => {
      await api("DELETE", `/venues/${v.id}`);
      toast("Bar deleted");
      go("#/");
    });
  });
  return h("div", null, form,
    h("div", { class: "card danger-zone", style: "margin-top:24px" }, h("h3", null, "Delete bar"),
      h("p", { class: "muted" }, "Removes everything for this bar. Its TVs go back to plain OpenGuide."), del));
}

/**
 * Colors for the TVs: OpenGuide's own, a ready-made theme, or two colors of the bar's choosing. The app works out
 * every shade from those two and keeps text readable, so there's nothing here that can make the TVs unreadable.
 */
function colorPicker(current, barName) {
  const DEFAULT = { primary: "#0a1024", secondary: "#ffb300" };
  const choices = [{ name: "OpenGuide", theme: null }, ...PRESETS.map((p) => ({ name: p.name, theme: { primary: p.primary, secondary: p.secondary } }))];
  const same = (a, b) => (a === null && b === null) || (a && b && a.primary === b.primary && a.secondary === b.secondary);
  let theme = current;
  // Custom is a mode of its own, chosen by its button, so two custom colors that happen to match a theme
  // don't snap back to that theme and hide the pickers.
  let customMode = current !== null && !choices.some((c) => same(c.theme, current));
  const isCustom = () => customMode;

  const swatches = h("div", { class: "swatches", role: "radiogroup", "aria-label": "Color theme" });
  const primary = h("input", { type: "color", value: (current || DEFAULT).primary });
  const secondary = h("input", { type: "color", value: (current || DEFAULT).secondary });
  const custom = h("div", { class: "row custom-colors" },
    h("label", { class: "field" }, "Main color", h("span", { class: "hint" }, "Backgrounds"), primary),
    h("label", { class: "field" }, "Highlight color", h("span", { class: "hint" }, "Titles, prices, selection"), secondary));
  const preview = h("div", { class: "tv-preview", "aria-hidden": "true" });

  function swatch(label, t, onPick) {
    const d = deriveTheme((t || DEFAULT).primary, (t || DEFAULT).secondary);
    const b = h("button", { type: "button", class: "swatch", role: "radio" },
      h("span", { class: "chip", style: `background:${d.bg};border-color:${d.accent}` }, h("span", { style: `background:${d.accent}` })),
      label);
    b.addEventListener("click", onPick);
    return b;
  }

  function draw() {
    swatches.replaceChildren(
      ...choices.map((c) => {
        const b = swatch(c.name, c.theme, () => {
          theme = c.theme;
          customMode = false;
          draw();
        });
        b.setAttribute("aria-checked", String(!isCustom() && same(c.theme, theme)));
        return b;
      }),
      (() => {
        const b = swatch("Custom", { primary: primary.value, secondary: secondary.value }, () => {
          if (!customMode) {
            // Start from the theme that was selected, so the pickers show where things stand.
            const start = theme || DEFAULT;
            primary.value = start.primary;
            secondary.value = start.secondary;
          }
          customMode = true;
          theme = { primary: primary.value, secondary: secondary.value };
          draw();
          primary.focus();
        });
        b.setAttribute("aria-checked", String(isCustom()));
        return b;
      })(),
    );
    custom.hidden = !isCustom();
    drawPreview();
  }

  function drawPreview() {
    const d = deriveTheme((theme || DEFAULT).primary, (theme || DEFAULT).secondary);
    const cell = (text, bg, color = d.text) => h("span", { style: `background:${bg};color:${color}` }, text);
    preview.style.background = d.bg;
    preview.replaceChildren(
      h("div", { class: "tvp-top" }, h("b", { style: `color:${d.accent}` }, barName()),
        h("span", { style: `background:${d.accent};color:${d.onAccent}` }, "Guide"), h("span", { style: `color:${d.text}` }, "Channels"),
        h("span", { style: `color:${d.muted};margin-left:auto` }, "8:30 PM")),
      h("div", { class: "tvp-hero" }, h("small", { style: `color:${d.accent}` }, "4  Sports Live"),
        h("strong", { style: `color:${d.text}` }, "Championship Game"), h("small", { style: `color:${d.muted}` }, "8:00 – 11:00 PM · 2h 30m left")),
      h("div", { class: "tvp-grid", style: `background:${d.header}` },
        cell("Sports Live", d.panel), cell("Championship Game", d.cellNow), cell("Post-game", d.cell),
        cell("News 24", d.panel), cell("Evening News", d.cell), cell("No listings", d.cellEmpty, d.muted)),
      h("div", { class: "tvp-banner", style: `background:${d.panel};border-color:${d.accent}` },
        h("small", { style: `color:${d.accent}` }, barName()), h("strong", { style: `color:${d.text}` }, "Happy Hour"),
        h("small", { style: `color:${d.text}` }, "$3 drafts until 7 PM")),
    );
  }

  const pickCustom = () => {
    customMode = true;
    theme = { primary: primary.value, secondary: secondary.value };
    draw();
  };
  primary.addEventListener("input", pickCustom);
  secondary.addEventListener("input", pickCustom);
  draw();

  return {
    el: h("fieldset", null, h("legend", null, "Colors on the TVs"),
      h("p", { class: "hint", style: "margin:0" }, "Pick a theme, or choose your own two colors. The TVs work out every shade from them and always keep text easy to read."),
      swatches, custom, preview,
      h("p", { class: "hint", style: "margin:0" }, "A TV restarts its picture for a moment when its colors change. CRT TV mode keeps its own colors.")),
    value: () => theme,
    redraw: drawPreview,
  };
}

// ----- signing in, setup, invites and resets -----

const MIN_PASSWORD = 10;

/** Calls /api/auth, which works without being signed in. */
async function auth(method, path, body) {
  const res = await fetch(`/api/auth${path}`, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

function signedIn(user) {
  me = user;
  showWho();
}

function showWho() {
  const who = document.getElementById("who");
  who.replaceChildren(...(me ? [h("span", null, me.name || me.email), h("a", { href: "#/account" }, "Account")] : []));
}

function authCard(title, intro, ...body) {
  return h("div", { class: "auth" }, h("h1", null, title), intro ? h("p", { class: "muted" }, intro) : null, ...body);
}

function passwordPair(label = "Password") {
  const pw = h("input", { type: "password", required: true, minlength: MIN_PASSWORD, maxlength: 200, autocomplete: "new-password" });
  const again = h("input", { type: "password", required: true, minlength: MIN_PASSWORD, maxlength: 200, autocomplete: "new-password" });
  return {
    els: [field(label, pw, `At least ${MIN_PASSWORD} characters. A short sentence is easy to remember and hard to guess.`), field("Type it again", again)],
    value() {
      if (pw.value.length < MIN_PASSWORD) throw new Error(`Use a password of at least ${MIN_PASSWORD} characters`);
      if (pw.value !== again.value) throw new Error("The two passwords don't match");
      return pw.value;
    },
  };
}

/** Where to go after signing in: the page that asked for it, or the bars list. */
let afterSignIn = "#/";

function loginPage() {
  const email = h("input", { type: "email", required: true, autocomplete: "username", maxlength: 254 });
  const pw = h("input", { type: "password", required: true, autocomplete: "current-password", maxlength: 200 });
  const go_ = h("button", { class: "primary" }, "Sign in");
  const form = h("form", { class: "card" }, field("Email", email), field("Password", pw), h("div", null, go_));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    busy(go_, async () => {
      signedIn(await auth("POST", "/login", { email: email.value, password: pw.value }));
      const target = afterSignIn;
      afterSignIn = "#/";
      go(target === "#/login" ? "#/" : target);
    });
  });
  setTimeout(() => email.focus(), 0);
  // Only a brand-new site needs this. Afterwards the owner reaches #/setup directly, to reset a forgotten
  // password with the setup code.
  const firstTime = h("p", { class: "muted small", hidden: true }, "Setting up this site for the first time? ",
    h("a", { href: "#/setup" }, "Create the owner account"));
  auth("GET", "/setup").then((s) => { firstTime.hidden = !s.needed; }, () => {});
  return authCard("Sign in", "Manage your bar's specials, menus, events and TVs.", form,
    h("p", { class: "muted small" }, "Forgot your password? Ask your bar's manager or the site owner for a reset link."),
    firstTime);
}

async function setupPage() {
  const status = await auth("GET", "/setup");
  const code = h("input", { type: "password", required: true, autocomplete: "off" });
  const name = h("input", { type: "text", maxlength: 80, autocomplete: "name" });
  const email = h("input", { type: "email", required: true, maxlength: 254, autocomplete: "username" });
  const pw = passwordPair(status.needed ? "Password" : "New password");
  const save = h("button", { class: "primary" }, status.needed ? "Create owner account" : "Set new password");
  const form = h("form", { class: "card" },
    field("Setup code", code, "The SETUP_CODE secret set when the site was deployed."),
    status.needed ? field("Your name", name) : null,
    field(status.needed ? "Email" : "Owner's email", email),
    ...pw.els,
    h("div", null, save));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    busy(save, async () => {
      signedIn(await auth("POST", "/setup", { code: code.value, name: name.value, email: email.value, password: pw.value() }));
      toast(status.needed ? "Owner account created" : "Password changed");
      go("#/");
    });
  });
  return status.needed
    ? authCard("Set up OpenGuide Bar", "Create the owner account. The owner sees and manages every bar, and invites each bar's manager.", form)
    : authCard("Reset the owner's password", "Setup is done. If you're the owner and forgot your password, the setup code lets you set a new one.", form,
      h("p", { class: "muted small" }, h("a", { href: "#/login" }, "Back to sign in")));
}

async function joinPage(token) {
  const invite = await auth("GET", `/invite/${encodeURIComponent(token)}`);
  const isNew = h("input", { type: "radio", name: "join-who", checked: true });
  const hasAccount = h("input", { type: "radio", name: "join-who" });
  const name = h("input", { type: "text", maxlength: 80, autocomplete: "name" });
  const email = h("input", { type: "email", required: true, maxlength: 254, autocomplete: "username" });
  const pw = passwordPair();
  const current = h("input", { type: "password", maxlength: 200, autocomplete: "current-password" });
  const newFields = h("div", { style: "display:grid;gap:16px" }, field("Your name", name), ...pw.els);
  const existingFields = field("Your password", current);
  const sync = () => {
    newFields.hidden = !isNew.checked;
    existingFields.hidden = isNew.checked;
  };
  isNew.addEventListener("change", sync);
  hasAccount.addEventListener("change", sync);
  sync();
  const save = h("button", { class: "primary" }, "Join");
  const form = h("form", { class: "card" },
    h("div", { class: "choice" }, h("label", null, isNew, "I'm new here"), h("label", null, hasAccount, "I already have an account")),
    field("Email", email), newFields, existingFields, h("div", null, save));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    busy(save, async () => {
      const body = isNew.checked
        ? { name: name.value, email: email.value, password: pw.value() }
        : { email: email.value, password: current.value };
      const user = await auth("POST", `/invite/${encodeURIComponent(token)}`, body);
      signedIn(user);
      toast(`Welcome to ${invite.bar}`);
      go(`#/bar/${user.venueId}/specials`);
    });
  });
  const roleText = invite.role === "manager"
    ? "As its manager, you can change its specials, menus, events and TVs, and invite your staff."
    : "You'll be able to change its specials, menus, events and TVs.";
  return authCard(`Join ${invite.bar}`, roleText, form);
}

async function resetPage(token) {
  const info = await auth("GET", `/reset/${encodeURIComponent(token)}`);
  const pw = passwordPair("New password");
  const save = h("button", { class: "primary" }, "Set password");
  const form = h("form", { class: "card" }, ...pw.els, h("div", null, save));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    busy(save, async () => {
      signedIn(await auth("POST", `/reset/${encodeURIComponent(token)}`, { password: pw.value() }));
      toast("Password changed. You're signed in.");
      go("#/");
    });
  });
  return authCard("Choose a new password", `For ${info.email}. This also signs you out on any other devices.`, form);
}

function accountPage() {
  const current = h("input", { type: "password", required: true, autocomplete: "current-password", maxlength: 200 });
  const pw = passwordPair("New password");
  const save = h("button", { class: "primary" }, "Change password");
  const form = h("form", { class: "card" }, field("Current password", current), ...pw.els, h("div", null, save));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    busy(save, async () => {
      await api("POST", "/account/password", { current: current.value, password: pw.value() });
      toast("Password changed. Other devices have been signed out.");
      form.reset();
    });
  });
  const out = h("button", { type: "button" }, "Sign out");
  out.addEventListener("click", () => busy(out, async () => {
    await auth("POST", "/logout");
    me = null;
    showWho();
    go("#/login");
  }));
  return h("div", null,
    h("h1", null, "Your account"),
    h("p", { class: "muted" }, `${me.name ? `${me.name}, ` : ""}${me.email}${me.owner ? " · site owner" : ""}`),
    h("h2", null, "Change password"), form,
    h("h2", null, "Sign out"), h("div", { class: "card row spread" }, h("span", { class: "muted" }, "Sign out of this browser."), out));
}

// ----- a bar's people -----

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Link copied");
  } catch {
    toast("Select the link and copy it", true);
  }
}

/** Shows a one-time link to pass on, with a copy button. */
function linkBox(title, link, note) {
  const input = h("input", { type: "text", value: link, readonly: true, onclick: (e) => e.target.select() });
  return h("div", { class: "card link-box" }, h("h3", null, title), h("p", { class: "muted small", style: "margin:0" }, note),
    h("div", { class: "row" }, h("div", { style: "flex:1;min-width:200px" }, input), h("button", { type: "button", class: "primary", onclick: () => copyText(link) }, "Copy")));
}

async function staffPage(ctx) {
  const data = await api("GET", `/venues/${ctx.venue.id}/staff`);
  const isOwner = ctx.venue.role === "owner";
  const fresh = h("div");

  async function invite(role, button) {
    await busy(button, async () => {
      const r = await api("POST", `/venues/${ctx.venue.id}/invites`, { role });
      fresh.replaceChildren(linkBox(`Invite link for a new ${role}`, r.link,
        `Send this to them by text or email. It works once, for ${Math.round((r.expiresAt - Date.now()) / 86_400_000)} days. ` +
          "Anyone with the link can join, so only send it to the person it's for."));
    });
  }
  const inviteStaff = h("button", { type: "button", class: "primary" }, "Invite staff");
  inviteStaff.addEventListener("click", () => invite("staff", inviteStaff));
  const inviteManager = isOwner ? h("button", { type: "button" }, "Invite a manager") : null;
  inviteManager?.addEventListener("click", () => invite("manager", inviteManager));

  const members = data.members.map((m) => {
    const canChange = isOwner || m.role !== "manager";
    const isMe = m.email === me.email;
    const actions = [];
    if (canChange && !isMe && m.hasAccount) {
      const reset = h("button", { class: "small" }, "Password reset link");
      reset.addEventListener("click", () => busy(reset, async () => {
        const r = await api("POST", `/venues/${ctx.venue.id}/staff/${encodeURIComponent(m.email)}/reset`);
        fresh.replaceChildren(linkBox(`Password reset link for ${m.email}`, r.link,
          `Send this only to ${m.email}. It works once, for ${Math.round((r.expiresAt - Date.now()) / 86_400_000)} days, and signs them out everywhere.`));
        fresh.scrollIntoView({ behavior: "smooth", block: "center" });
      }));
      actions.push(reset);
    }
    if (canChange && !isMe) {
      const remove = h("button", { class: "small danger" }, "Remove");
      remove.addEventListener("click", () => {
        if (!confirm(`Remove ${m.email} from ${ctx.venue.name}? They won't be able to manage it any more.`)) return;
        busy(remove, async () => {
          await api("DELETE", `/venues/${ctx.venue.id}/staff/${encodeURIComponent(m.email)}`);
          toast("Removed");
          render();
        });
      });
      actions.push(remove);
    }
    return h("li", { class: "card item" },
      h("div", { class: "body" },
        h("h3", null, m.name || m.email, h("span", { class: `badge ${m.role === "manager" ? "ok" : ""}` }, m.role === "manager" ? "Manager" : "Staff"), isMe ? h("span", { class: "badge" }, "You") : null),
        h("p", { class: "muted small" }, m.name ? m.email : `Added ${ago(m.addedAt)}`)),
      h("div", { class: "actions" }, actions));
  });

  const invites = data.invites.map((i) => {
    const cancel = h("button", { class: "small danger" }, "Cancel");
    cancel.addEventListener("click", () => busy(cancel, async () => {
      await api("DELETE", `/venues/${ctx.venue.id}/invites/${i.id}`);
      render();
    }));
    return h("li", { class: "card item" },
      h("div", { class: "body" }, h("h3", null, `Invite for ${i.role === "manager" ? "a manager" : "staff"}`),
        h("p", { class: "muted small" }, `Made by ${i.createdBy} ${ago(i.createdAt)}, unused. Expires ${when(i.expiresAt, ctx.tz)}.`)),
      h("div", { class: "actions" }, cancel));
  });

  return h("div", null,
    h("div", { class: "card", style: "display:grid;gap:10px" },
      h("h3", null, "Invite someone"),
      h("p", { class: "muted", style: "margin:0" },
        "Staff can change this bar's specials, menus, events, TVs, name and logo. ",
        isOwner ? "Managers can also invite and remove staff, and make password reset links for them." : "Only the site owner can add managers."),
      h("div", { class: "row" }, inviteStaff, inviteManager)),
    fresh,
    h("h2", null, "People"),
    members.length ? h("ul", { class: "list" }, members) : h("div", { class: "card empty" }, isOwner ? "Nobody yet. Invite the bar's manager to get started." : "Nobody yet."),
    invites.length ? [h("h2", null, "Unused invites"), h("ul", { class: "list" }, invites)] : null);
}

window.addEventListener("hashchange", render);
render();
