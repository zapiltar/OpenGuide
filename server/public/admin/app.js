// OpenGuide Bar admin site. Plain DOM, no build step. Pages are chosen by the URL hash:
//   #/                         bars you can manage
//   #/new-bar                  add a bar (owner)
//   #/bar/<id>/<tab>[/<item>]  a bar's specials, menus, events, screens, settings or staff
//
// Every time shown or entered here is in the bar's own time zone, not the browser's.

import { localParts, occurrences, zonedTime } from "/shared/schedule.js";

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
    if (!me) {
      me = await api("GET", "/me");
      document.getElementById("who").textContent = me.email;
    }
    let view;
    if (parts[0] === "new-bar") view = await newBarPage();
    else if (parts[0] === "bar" && parts[1]) view = await barPage(parts[1], parts[2] || "specials", parts[3]);
    else view = await homePage();
    if (id !== renderId || !view) return; // a newer page replaced this one while it loaded
    app.replaceChildren(view);
    window.scrollTo(0, 0);
  } catch (e) {
    if (id !== renderId) return;
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
      go(`#/bar/${v.id}/screens`);
    });
  });
  return h("div", null, h("h1", null, "Add a bar"), h("p", { class: "muted" }, "After this, link its TVs and add staff."), form);
}

const TABS = [
  ["specials", "Specials"],
  ["menus", "Menus"],
  ["events", "Events"],
  ["screens", "Screens"],
  ["settings", "Name & logo"],
  ["staff", "Staff", true],
];

async function barPage(venueId, tab, item) {
  const [venue, screens] = await Promise.all([api("GET", `/venues/${venueId}`), api("GET", `/venues/${venueId}/screens`)]);
  const ctx = { venue, screens, tz: venue.timezone, base: `#/bar/${venueId}` };
  const pages = { specials: [specialsList, specialEditor], menus: [menusList, menuEditor], events: [eventsList, eventEditor] };
  let body;
  if (pages[tab]) body = await (item ? pages[tab][1] : pages[tab][0])(ctx, item);
  else if (tab === "screens") body = screensPage(ctx);
  else if (tab === "settings") body = settingsPage(ctx);
  else if (tab === "staff" && me.owner) body = await staffPage(ctx);
  else throw Object.assign(new Error("That page doesn't exist."), { status: 404 });

  return h("div", null,
    h("div", { class: "bar-head" }, venue.logoUrl ? h("img", { src: venue.logoUrl, alt: "" }) : null,
      h("div", null, h("h1", null, venue.name), h("div", { class: "muted small" }, venue.timezone.replace(/_/g, " ")))),
    h("nav", { class: "tabs", "aria-label": "Bar sections" },
      TABS.filter(([, , ownerOnly]) => !ownerOnly || me.owner).map(([key, label]) =>
        h("a", { href: `${ctx.base}/${key}`, "aria-current": key === tab ? "page" : null }, label))),
    body);
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
          s.display === "takeover" ? "Full screen" : "Banner",
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
  const image = imageField(ctx.venue.id, s.image, s.imageUrl, { hint: "Optional. Shown beside the text." });

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
  [banner, takeover, untilEnd].forEach((x) => x.addEventListener("change", syncDisplay));
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
        h("label", null, takeover, h("span", null, h("strong", null, "Full screen"), h("span", { class: "hint" }, "Covers the picture, then goes back to the channel. Up to 10 minutes.")))),
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
      const body = {
        title: title.value,
        text: text.value,
        image: image.value(),
        schedule,
        display: banner.checked ? "banner" : "takeover",
        timeoutSeconds: untilEnd.checked ? null : Number(seconds.value),
        repeatMinutes: repeat.checked ? Number(repeatMin.value) : null,
        enabled: enabled.checked,
        screens: screens.value(),
      };
      await (isNew
        ? api("POST", `/venues/${ctx.venue.id}/specials`, body)
        : api("PUT", `/venues/${ctx.venue.id}/specials/${itemId}`, body));
      toast("Saved. TVs pick it up within 10 minutes.");
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
          h("textarea", { placeholder: "Description (optional)", maxlength: 300, "aria-label": "Description", oninput: (e) => (it.description = e.target.value) }, it.description || ""))),
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

async function eventsList(ctx) {
  const items = await api("GET", `/venues/${ctx.venue.id}/events`);
  const now = Date.now();
  const upcoming = items.filter((e) => (e.end ?? e.start) >= now);
  const past = items.filter((e) => (e.end ?? e.start) < now).reverse().slice(0, 10);
  const row = (e) => h("li", null, h("a", { class: "card item item-link", href: `${ctx.base}/events/${e.id}` },
    thumb(e.imageUrl),
    h("div", { class: "body" },
      h("h3", null, e.title, e.start <= now && (e.end ?? e.start) >= now ? h("span", { class: "badge ok" }, "On now") : null),
      h("p", { class: "small" }, e.end ? `${when(e.start, ctx.tz)} to ${when(e.end, ctx.tz)}` : when(e.start, ctx.tz)),
      h("p", { class: "muted small" }, screensText(e.screens, ctx.screens)))));
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
    ? { title: "", description: "", image: null, imageUrl: null, start: null, end: null, screens: null }
    : await api("GET", `/venues/${ctx.venue.id}/events/${itemId}`);
  const tz = ctx.tz;
  const title = h("input", { type: "text", required: true, maxlength: 100, value: e.title });
  const desc = h("textarea", { maxlength: 1000 }, e.description || "");
  const image = imageField(ctx.venue.id, e.image, e.imageUrl, { hint: "Optional. A poster or photo." });
  const start = h("input", { type: "datetime-local", required: true, value: toInput(e.start, tz) });
  const end = h("input", { type: "datetime-local", value: toInput(e.end, tz) });
  const screens = screenPicker(ctx.screens, e.screens);
  const save = h("button", { class: "primary" }, isNew ? "Add event" : "Save");
  const del = isNew ? null : h("button", { type: "button", class: "danger" }, "Delete");
  const form = h("form", { class: "card" },
    field("Title", title),
    field("Details", desc, "Optional."),
    image.el,
    h("div", { class: "row" }, field("Starts", start), field("Ends", end, "Optional")),
    h("p", { class: "hint", style: "margin:0" }, `Times are in the bar's time zone (${tz.replace(/_/g, " ")}).`),
    screens.el,
    h("div", { class: "form-actions" }, h("div", { class: "row" }, save, h("a", { class: "button", href: `${ctx.base}/events` }, "Cancel")), del));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    busy(save, async () => {
      const body = {
        title: title.value,
        description: desc.value,
        image: image.value(),
        start: fromInput(start.value, tz),
        end: fromInput(end.value, tz),
        screens: screens.value(),
      };
      if (!body.start) throw new Error("Enter when it starts");
      await (isNew ? api("POST", `/venues/${ctx.venue.id}/events`, body) : api("PUT", `/venues/${ctx.venue.id}/events/${itemId}`, body));
      toast("Saved");
      go(`${ctx.base}/events`);
    });
  });
  del?.addEventListener("click", () => deleteItem(del, ctx, "events", itemId, e.title));
  return h("div", null, h("h2", { style: "margin-top:0" }, isNew ? "New event" : "Edit event"), form);
}

// ----- screens -----

const ONLINE_MS = 20 * 60 * 1000; // TVs check in every 10 minutes

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
    else if (s.lastSeen && now - s.lastSeen < ONLINE_MS) status = h("span", { class: "badge ok" }, "Online");
    else status = h("span", { class: "badge" }, s.lastSeen ? `Last seen ${ago(s.lastSeen)}` : "Not seen yet");
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
      if (!confirm(`Unlink “${s.name}”? It goes back to plain OpenGuide at its next check, within 10 minutes.`)) return;
      busy(unlink, async () => {
        await api("DELETE", `/venues/${ctx.venue.id}/screens/${s.id}`);
        toast("Unlinked");
        render();
      });
    });
    return h("li", { class: "card item" },
      h("div", { class: "body" }, h("h3", null, s.name, status), s.appVersion ? h("p", { class: "muted small" }, `OpenGuide ${s.appVersion}`) : null),
      h("div", { class: "actions" }, rename, unlink));
  });
  return h("div", null, form,
    h("h2", null, "Screens"),
    list.length ? h("ul", { class: "list" }, list) : h("div", { class: "card empty" }, "No TVs linked yet."));
}

// ----- name, logo and time zone -----

function settingsPage(ctx) {
  const v = ctx.venue;
  const name = me.owner ? h("input", { type: "text", required: true, maxlength: 100, value: v.name }) : null;
  const display = h("input", { type: "text", maxlength: 60, value: v.displayName || "", placeholder: v.name });
  const logo = imageField(v.id, v.logo, v.logoUrl, { label: "Logo", hint: "Shown on the TVs in place of OpenGuide's. A square PNG with a clear background works best." });
  const tz = timeZoneSelect(v.timezone);
  const save = h("button", { class: "primary" }, "Save");
  const form = h("form", { class: "card" },
    name ? field("Bar name", name, "Only you, the site owner, can change this.") : null,
    field("Name on TVs", display, "Shown on the TVs in place of OpenGuide. Leave empty to use the bar name."),
    logo.el,
    field("Time zone", tz, "Specials and events run on this clock."),
    h("div", null, save));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    busy(save, async () => {
      const body = { displayName: display.value, logo: logo.value(), timezone: tz.value };
      if (name) body.name = name.value;
      await api("PATCH", `/venues/${v.id}`, body);
      toast("Saved. TVs pick it up within 10 minutes.");
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

// ----- staff -----

async function staffPage(ctx) {
  const staff = await api("GET", `/venues/${ctx.venue.id}/staff`);
  const email = h("input", { type: "email", required: true, maxlength: 254, placeholder: "name@example.com" });
  const add = h("button", { class: "primary" }, "Add");
  const form = h("form", { class: "card" },
    h("h3", null, "Add staff"),
    h("p", { class: "muted", style: "margin:0" },
      "Staff can change this bar's specials, menus, events, screens, name on TVs and logo. ",
      "They must also be allowed in your Cloudflare Access policy, or they won't be able to sign in."),
    h("div", { class: "row" }, h("div", { style: "flex:1;min-width:220px" }, email), add));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    busy(add, async () => {
      await api("POST", `/venues/${ctx.venue.id}/staff`, { email: email.value });
      toast("Added");
      render();
    });
  });
  const list = staff.map((s) => {
    const remove = h("button", { class: "small danger" }, "Remove");
    remove.addEventListener("click", () => {
      if (!confirm(`Remove ${s.email} from ${ctx.venue.name}?`)) return;
      busy(remove, async () => {
        await api("DELETE", `/venues/${ctx.venue.id}/staff/${encodeURIComponent(s.email)}`);
        render();
      });
    });
    return h("li", { class: "card item" }, h("div", { class: "body" }, h("h3", null, s.email), h("p", { class: "muted small" }, `Added ${ago(s.addedAt)}`)),
      h("div", { class: "actions" }, remove));
  });
  return h("div", null, form, h("h2", null, "Staff"),
    list.length ? h("ul", { class: "list" }, list) : h("div", { class: "card empty" }, "No staff yet. You can manage this bar yourself."));
}

window.addEventListener("hashchange", render);
render();
