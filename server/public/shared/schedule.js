// Shared by the Worker (through src/schedule.js) and the admin site, which loads it from /shared/schedule.js.

// Turns a special's schedule into absolute start and end times, so the TV app only has to compare times.
//
// One-off specials are stored as absolute times. Weekly ones are stored as days and wall-clock times in the bar's
// time zone, and are expanded here with the platform's time zone data:
// - A start inside a daylight-saving gap (02:30 on the night clocks skip 02:00 to 03:00) moves forward by the gap.
// - A start that happens twice (01:30 on the night clocks go back) uses the first one.
// - An end time at or before the start time means the special runs past midnight into the next day.

const DAY = 86_400_000;
const formatters = new Map();

function formatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isTimeZone(name) {
  if (typeof name !== "string" || !name) return false;
  try {
    formatter(name);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock fields of instant [t] in [timeZone]. */
export function localParts(t, timeZone) {
  const out = {};
  for (const p of formatter(timeZone).formatToParts(new Date(t))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out; // year, month (1-12), day, hour, minute, second
}

/** How far [timeZone]'s clocks are ahead of UTC at instant [t], in milliseconds. */
function offsetAt(t, timeZone) {
  const p = localParts(t, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** The instant when clocks in [timeZone] read the given date and time. See the top of this file for DST rules. */
export function zonedTime(year, month, day, hour, minute, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetAt(wall - DAY / 2, timeZone);
  const after = offsetAt(wall + DAY / 2, timeZone);
  const matches = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((t) => {
      const p = localParts(t, timeZone);
      return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
    });
  if (matches.length) return Math.min(...matches);
  return wall - before; // In a gap: the same distance past the change as the wall time is.
}

function parseClock(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return { h, m, minutes: h * 60 + m };
}

/**
 * Every occurrence of [schedule] that overlaps [from, to), as {start, end} in Unix milliseconds, oldest first.
 */
export function occurrences(schedule, timeZone, from, to) {
  if (schedule.type === "once") {
    return schedule.end > from && schedule.start < to ? [{ start: schedule.start, end: schedule.end }] : [];
  }
  const start = parseClock(schedule.start);
  const end = parseClock(schedule.end);
  const overnight = end.minutes <= start.minutes;
  const days = new Set(schedule.days);
  // Begin a day early, so an overnight occurrence that started yesterday is included.
  const first = localParts(from - DAY, timeZone);
  let date = Date.UTC(first.year, first.month - 1, first.day);
  const out = [];
  for (;;) {
    const d = new Date(date);
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth() + 1;
    const da = d.getUTCDate();
    const s = zonedTime(y, mo, da, start.h, start.m, timeZone);
    if (s >= to) break;
    if (days.has(d.getUTCDay())) {
      const endDate = new Date(overnight ? date + DAY : date);
      const e = zonedTime(endDate.getUTCFullYear(), endDate.getUTCMonth() + 1, endDate.getUTCDate(), end.h, end.m, timeZone);
      if (e > from) out.push({ start: s, end: e });
    }
    date += DAY;
  }
  return out;
}
