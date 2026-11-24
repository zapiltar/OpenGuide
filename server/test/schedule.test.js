import { describe, expect, it } from "vitest";
import { occurrences, zonedTime } from "../src/schedule.js";

const iso = (t) => new Date(t).toISOString();
const NY = "America/New_York";

describe("zonedTime", () => {
  it("converts an ordinary local time", () => {
    expect(iso(zonedTime(2026, 7, 4, 17, 0, NY))).toBe("2026-07-04T21:00:00.000Z"); // EDT, UTC-4
    expect(iso(zonedTime(2026, 1, 15, 17, 0, NY))).toBe("2026-01-15T22:00:00.000Z"); // EST, UTC-5
  });

  it("moves a time in the spring-forward gap forward by the gap", () => {
    // 8 March 2026: 02:00 EST jumps to 03:00 EDT, so 02:30 doesn't exist and becomes 03:30 EDT.
    expect(iso(zonedTime(2026, 3, 8, 2, 30, NY))).toBe("2026-03-08T07:30:00.000Z");
  });

  it("uses the first of a time that happens twice", () => {
    // 1 November 2026: 01:30 happens in EDT, then again in EST. Take the EDT one.
    expect(iso(zonedTime(2026, 11, 1, 1, 30, NY))).toBe("2026-11-01T05:30:00.000Z");
  });

  it("handles half-hour zones", () => {
    expect(iso(zonedTime(2026, 5, 1, 18, 0, "Asia/Kolkata"))).toBe("2026-05-01T12:30:00.000Z");
  });
});

describe("occurrences", () => {
  it("returns a one-off special that overlaps the window", () => {
    const s = { type: "once", start: Date.UTC(2026, 5, 1, 20), end: Date.UTC(2026, 5, 1, 22) };
    expect(occurrences(s, NY, Date.UTC(2026, 5, 1), Date.UTC(2026, 5, 2))).toEqual([{ start: s.start, end: s.end }]);
    expect(occurrences(s, NY, Date.UTC(2026, 5, 2), Date.UTC(2026, 5, 3))).toEqual([]);
  });

  it("expands a weekly happy hour on the chosen days only", () => {
    // Weekdays 4pm to 7pm. 1 June 2026 is a Monday.
    const s = { type: "weekly", days: [1, 2, 3, 4, 5], start: "16:00", end: "19:00" };
    const from = zonedTime(2026, 6, 1, 0, 0, NY);
    const to = zonedTime(2026, 6, 8, 0, 0, NY);
    const out = occurrences(s, NY, from, to).map((o) => [iso(o.start), iso(o.end)]);
    expect(out).toEqual([
      ["2026-06-01T20:00:00.000Z", "2026-06-01T23:00:00.000Z"],
      ["2026-06-02T20:00:00.000Z", "2026-06-02T23:00:00.000Z"],
      ["2026-06-03T20:00:00.000Z", "2026-06-03T23:00:00.000Z"],
      ["2026-06-04T20:00:00.000Z", "2026-06-04T23:00:00.000Z"],
      ["2026-06-05T20:00:00.000Z", "2026-06-05T23:00:00.000Z"],
    ]);
  });

  it("runs past midnight when the end is before the start", () => {
    // Friday late night, 10pm to 2am. 5 June 2026 is a Friday.
    const s = { type: "weekly", days: [5], start: "22:00", end: "02:00" };
    const out = occurrences(s, NY, zonedTime(2026, 6, 1, 0, 0, NY), zonedTime(2026, 6, 8, 0, 0, NY));
    expect(out.map((o) => [iso(o.start), iso(o.end)])).toEqual([["2026-06-06T02:00:00.000Z", "2026-06-06T06:00:00.000Z"]]);
  });

  it("includes an overnight special that started before the window and is still on", () => {
    const s = { type: "weekly", days: [5], start: "22:00", end: "02:00" };
    const from = zonedTime(2026, 6, 6, 0, 30, NY); // Saturday 00:30, during Friday night's special
    const out = occurrences(s, NY, from, from + 3_600_000);
    expect(out.map((o) => iso(o.start))).toEqual(["2026-06-06T02:00:00.000Z"]);
  });

  it("keeps the local time across a daylight saving change", () => {
    // Every day at 5pm local, across 8 March 2026 when New York moves from UTC-5 to UTC-4.
    const s = { type: "weekly", days: [0, 1, 2, 3, 4, 5, 6], start: "17:00", end: "18:00" };
    const out = occurrences(s, NY, Date.UTC(2026, 2, 7, 12), Date.UTC(2026, 2, 9, 12));
    expect(out.map((o) => iso(o.start))).toEqual([
      "2026-03-07T22:00:00.000Z",
      "2026-03-08T21:00:00.000Z",
    ]);
  });

  it("gives a special that crosses the clocks going back its real length", () => {
    // Saturday 31 October 2026, 11pm to 3am. Clocks go back at 2am, so it lasts five hours.
    const s = { type: "weekly", days: [6], start: "23:00", end: "03:00" };
    const [o] = occurrences(s, NY, Date.UTC(2026, 9, 31), Date.UTC(2026, 10, 2));
    expect((o.end - o.start) / 3_600_000).toBe(5);
  });
});
