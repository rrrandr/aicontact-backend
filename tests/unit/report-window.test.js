import { weeklyWindow, zonedParts, REPORT_TIMEZONE } from "../../src/v2/services/reportWindow";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** What the New York wall clock reads at an instant, as a comparable string. */
const nyc = (date) => {
  const p = zonedParts(date, REPORT_TIMEZONE);
  const pad = (n) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
};

describe("the weekly reporting window", () => {
  it("ends at the most recent Monday 09:00 in New York", () => {
    // A Thursday afternoon in winter.
    const now = new Date("2026-01-15T20:00:00Z");
    const { end } = weeklyWindow(now);
    expect(nyc(end)).toBe("2026-01-12 09:00");
  });

  it("covers exactly the seven days before that", () => {
    const { start, end } = weeklyWindow(new Date("2026-01-15T20:00:00Z"));
    expect(end.getTime() - start.getTime()).toBe(7 * DAY);
    expect(nyc(start)).toBe("2026-01-05 09:00");
  });

  it("does not close a week that has not reached nine o'clock yet", () => {
    // Monday 08:30 New York. The week ending at 09:00 today is not finished,
    // so the report still owed is last week's.
    const { end } = weeklyWindow(new Date("2026-01-12T13:30:00Z"));
    expect(nyc(end)).toBe("2026-01-05 09:00");
  });

  it("closes the week the moment nine o'clock arrives", () => {
    const { end } = weeklyWindow(new Date("2026-01-12T14:00:00Z"));
    expect(nyc(end)).toBe("2026-01-12 09:00");
  });

  it("gives every instant in a week the same window", () => {
    // This is what makes delivery idempotent: whenever the job runs during the
    // week, it computes the same key and finds the same stored report.
    const monday9 = new Date("2026-01-12T14:00:00Z");
    const keys = new Set();
    for (let offset = 0; offset < 7 * DAY; offset += 3 * HOUR) {
      const { start, end } = weeklyWindow(new Date(monday9.getTime() + offset));
      keys.add(`${start.toISOString()}|${end.toISOString()}`);
    }
    expect(keys.size).toBe(1);
  });

  it("stays at 09:00 local across the spring clock change", () => {
    // 2026 US DST begins Sunday 8 March. The Monday after is 9 March; a window
    // computed in absolute hours would land at 08:00 or 10:00 instead.
    const { start, end } = weeklyWindow(new Date("2026-03-12T16:00:00Z"));
    expect(nyc(end)).toBe("2026-03-09 09:00");
    expect(nyc(start)).toBe("2026-03-02 09:00");
    // 23 hours short of seven days, because that week really was an hour short.
    expect(end.getTime() - start.getTime()).toBe(7 * DAY - HOUR);
  });

  it("stays at 09:00 local across the autumn clock change", () => {
    // DST ends Sunday 1 November 2026; the week gains an hour.
    const { start, end } = weeklyWindow(new Date("2026-11-05T16:00:00Z"));
    expect(nyc(end)).toBe("2026-11-02 09:00");
    expect(nyc(start)).toBe("2026-10-26 09:00");
    expect(end.getTime() - start.getTime()).toBe(7 * DAY + HOUR);
  });

  it("produces windows that abut, so no day is counted twice or missed", () => {
    const thisWeek = weeklyWindow(new Date("2026-01-15T20:00:00Z"));
    // An hour before this week closed, the week that was owed was the one
    // before it.
    const lastWeek = weeklyWindow(new Date(thisWeek.end.getTime() - HOUR));
    expect(lastWeek.end.getTime()).toBe(thisWeek.start.getTime());
  });

  it("honours a different timezone when one is configured", () => {
    const utc = weeklyWindow(new Date("2026-01-15T20:00:00Z"), "UTC");
    expect(utc.end.toISOString()).toBe("2026-01-12T09:00:00.000Z");
  });
});
