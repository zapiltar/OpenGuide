import { HttpError } from "./http.js";
import { isTimeZone, zonedTime } from "./schedule.js";
import { isHexColor } from "../public/shared/theme.js";

const bad = (message) => new HttpError(400, message);

export function text(value, field, { max = 200, required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw bad(`${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw bad(`${field} must be text`);
  const v = value.trim();
  if (required && !v) throw bad(`${field} is required`);
  if (v.length > max) throw bad(`${field} must be ${max} characters or fewer`);
  return v || null;
}

export function integer(value, field, { min, max, nullable = false } = {}) {
  if (value === undefined || value === null) {
    if (nullable) return null;
    throw bad(`${field} is required`);
  }
  if (!Number.isInteger(value)) throw bad(`${field} must be a whole number`);
  if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
    throw bad(`${field} must be between ${min} and ${max}`);
  }
  return value;
}

/** A Unix time in milliseconds, within a sane range. */
export function time(value, field, { nullable = false } = {}) {
  return integer(value, field, { min: Date.UTC(2020, 0, 1), max: Date.UTC(2100, 0, 1), nullable });
}

export function oneOf(value, field, options, fallback) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw bad(`${field} is required`);
  }
  if (!options.includes(value)) throw bad(`${field} must be one of: ${options.join(", ")}`);
  return value;
}

export function email(value, field = "email") {
  const v = text(value, field, { max: 254, required: true }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw bad(`${field} isn't a valid email address`);
  return v;
}

export function timeZone(value, field = "timezone") {
  const v = text(value, field, { max: 64, required: true });
  if (!isTimeZone(v)) throw bad(`${field} must be a time zone such as America/New_York`);
  return v;
}

/** An uploaded image key, which must belong to this bar. */
export function imageKey(value, venueId, field = "image") {
  const v = text(value, field, { max: 200 });
  if (v && !v.startsWith(`${venueId}/`)) throw bad(`${field} must be an image uploaded for this bar`);
  return v;
}

/** How a screen shows channels: full picture, always framed, or framed only while a special is on. */
export const LAYOUTS = ["full", "framed", "specials"];

/** null for every screen, or a list of this bar's screen ids. */
export function screenList(value, venueScreenIds) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 200) throw bad("screens must be a list of screen ids, or null for all");
  const known = new Set(venueScreenIds);
  for (const id of value) {
    if (!known.has(id)) throw bad(`Screen ${id} isn't one of this bar's screens`);
  }
  return [...new Set(value)];
}

export function menuSections(value, venueId) {
  if (!Array.isArray(value) || value.length === 0) throw bad("sections must be a list with at least one section");
  if (value.length > 20) throw bad("A menu can have at most 20 sections");
  return value.map((s, i) => {
    if (!s || typeof s !== "object") throw bad(`Section ${i + 1} is invalid`);
    const items = s.items;
    if (!Array.isArray(items) || items.length > 100) throw bad(`Section ${i + 1} needs a list of up to 100 items`);
    return {
      title: text(s.title, `Section ${i + 1} title`, { max: 100 }),
      items: items.map((it, j) => {
        const where = `Section ${i + 1}, item ${j + 1}`;
        if (!it || typeof it !== "object") throw bad(`${where} is invalid`);
        return {
          name: text(it.name, `${where} name`, { max: 100, required: true }),
          price: text(it.price, `${where} price`, { max: 20 }),
          description: text(it.description, `${where} description`, { max: 300 }),
          image: imageKey(it.image, venueId, `${where} picture`),
        };
      }),
    };
  });
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export function schedule(value) {
  if (!value || typeof value !== "object") throw bad("schedule is required");
  if (value.type === "once") {
    const start = time(value.start, "schedule.start");
    const end = time(value.end, "schedule.end");
    if (end <= start) throw bad("schedule.end must be after schedule.start");
    if (end - start > 14 * 86_400_000) throw bad("A one-off special can last at most 14 days");
    return { type: "once", start, end };
  }
  if (value.type === "weekly") {
    const days = value.days;
    if (!Array.isArray(days) || days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw bad("schedule.days must list days 0 (Sunday) to 6 (Saturday)");
    }
    if (!CLOCK.test(value.start ?? "") || !CLOCK.test(value.end ?? "")) {
      throw bad("schedule.start and schedule.end must be times like 16:00");
    }
    if (value.start === value.end) throw bad("schedule.start and schedule.end can't be the same time");
    return { type: "weekly", days: [...new Set(days)].sort(), start: value.start, end: value.end };
  }
  throw bad('schedule.type must be "once" or "weekly"');
}

/** A bar's two theme colors, or null for OpenGuide's own. */
export function theme(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || !isHexColor(value.primary) || !isHexColor(value.secondary)) {
    throw bad('theme must be null or {"primary": "#rrggbb", "secondary": "#rrggbb"}');
  }
  return { primary: value.primary.toLowerCase(), secondary: value.secondary.toLowerCase() };
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function date(value, field) {
  const m = DATE.exec(value ?? "");
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!m || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3] || +m[1] < 2020 || +m[1] > 2099) {
    throw bad(`${field} must be a date like 2026-12-31`);
  }
  return { y: +m[1], mo: +m[2], d: +m[3], text: value };
}

/**
 * A weekly repeat for an event, checked, with the time range it covers in [timeZone]: from the start of
 * "from" to the end of "until" (endsAt null when it has no end date).
 */
export function eventRepeat(value, timeZone) {
  if (!value || typeof value !== "object") throw bad("repeat must describe the days and times");
  const days = value.days;
  if (!Array.isArray(days) || days.length === 0 || days.some((x) => !Number.isInteger(x) || x < 0 || x > 6)) {
    throw bad("repeat.days must list days 0 (Sunday) to 6 (Saturday)");
  }
  if (!CLOCK.test(value.start ?? "")) throw bad("repeat.start must be a time like 20:00");
  const end = value.end === undefined || value.end === null || value.end === "" ? null : value.end;
  if (end !== null && !CLOCK.test(end)) throw bad("repeat.end must be a time like 22:00, or empty");
  if (end === value.start) throw bad("repeat.start and repeat.end can't be the same time");
  const from = date(value.from, "repeat.from");
  const until = value.until ? date(value.until, "repeat.until") : null;
  if (until && until.text < from.text) throw bad("repeat.until can't be before repeat.from");
  const nextDay = (x) => new Date(Date.UTC(x.y, x.mo - 1, x.d + 1));
  const after = until && nextDay(until);
  return {
    repeat: { days: [...new Set(days)].sort(), start: value.start, end, from: from.text, until: until?.text ?? null },
    startsAt: zonedTime(from.y, from.mo, from.d, 0, 0, timeZone),
    endsAt: after ? zonedTime(after.getUTCFullYear(), after.getUTCMonth() + 1, after.getUTCDate(), 0, 0, timeZone) : null,
  };
}

export const CHANNEL_DEFAULTS = Object.freeze({
  enabled: true, onNow: true, later: true, events: true, posters: true, hiddenMenus: [], seconds: 12,
});
export const CHANNEL_SECONDS = [8, 12, 20, 30];

/** A bar's stored channel settings, with defaults filled in. */
export function channelOf(stored) {
  return { ...CHANNEL_DEFAULTS, ...(stored ? JSON.parse(stored) : {}) };
}

/** Bar Channel settings from the admin site. Missing fields keep [current]'s values. */
export function channel(value, current, menuIds) {
  if (!value || typeof value !== "object") throw bad("channel must be an object");
  const next = { ...current };
  for (const k of ["enabled", "onNow", "later", "events", "posters"]) {
    if (k in value) {
      if (typeof value[k] !== "boolean") throw bad(`channel.${k} must be true or false`);
      next[k] = value[k];
    }
  }
  if ("seconds" in value) next.seconds = oneOf(value.seconds, "channel.seconds", CHANNEL_SECONDS);
  if ("hiddenMenus" in value) {
    if (!Array.isArray(value.hiddenMenus)) throw bad("channel.hiddenMenus must be a list of menu ids");
    const known = new Set(menuIds);
    next.hiddenMenus = [...new Set(value.hiddenMenus)].filter((id) => known.has(id));
  }
  return next;
}

export const TIMEOUT_DEFAULTS = { banner: 30, takeover: 15, picture: 15 };

/**
 * Seconds a special stays on screen each time. null ("until the special ends") is only allowed for banners,
 * so a takeover can never hide the picture for long.
 */
export function timeoutSeconds(value, display) {
  if (value === undefined) return TIMEOUT_DEFAULTS[display];
  if (value === null) {
    if (display !== "banner") throw bad("A full-screen special needs a timeout of 5 to 600 seconds");
    return null;
  }
  return integer(value, "timeoutSeconds", { min: 5, max: 600 });
}
