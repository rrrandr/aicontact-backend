/**
 * The weekly reporting window, in a named timezone.
 *
 * Pure and side-effect free so every boundary - including the two Sundays a
 * year when the local clock jumps - can be tested without a database or a
 * clock. The window is the seven days between consecutive trigger times, so
 * consecutive reports abut exactly: no day is counted twice and none is lost.
 */

export const REPORT_TIMEZONE = "America/New_York";
// Monday, 09:00 local.
export const REPORT_WEEKDAY = 1;
export const REPORT_HOUR = 9;

const FIELDS = ["year", "month", "day", "hour", "minute", "second"];

/** The wall clock reading in `timeZone` at a given instant. */
export const zonedParts = (date, timeZone) => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (FIELDS.includes(part.type)) parts[part.type] = Number(part.value);
  }
  // Some ICU builds render midnight as hour 24.
  if (parts.hour === 24) parts.hour = 0;
  return parts;
};

/** How far the zone is from UTC at this instant, in milliseconds. */
const offsetAt = (date, timeZone) => {
  const p = zonedParts(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
};

/**
 * The instant at which the wall clock in `timeZone` reads the given local time.
 *
 * Two passes, because the offset that converts the guess is itself a function
 * of the answer: on a DST boundary the first pass can land an hour out, and the
 * second corrects it.
 */
export const zonedTimeToInstant = ({ year, month, day, hour = 0 }, timeZone) => {
  const target = Date.UTC(year, month - 1, day, hour);
  let instant = target - offsetAt(new Date(target), timeZone);
  instant = target - offsetAt(new Date(instant), timeZone);
  return new Date(instant);
};

/**
 * The most recent Monday 09:00 local at or before `now`, and the seven days
 * it closes off.
 *
 * A run at any point during the week produces the same window, so a retry -
 * or a second process - computes the same period and therefore collides on
 * the same stored report rather than sending a second one.
 */
export const weeklyWindow = (now = new Date(), timeZone = REPORT_TIMEZONE) => {
  const local = zonedParts(now, timeZone);

  // Day of week for the local calendar date, read back through UTC so the
  // process timezone cannot influence it.
  const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
  const daysSinceMonday = (weekday - REPORT_WEEKDAY + 7) % 7;

  const at = (daysBack) =>
    zonedTimeToInstant(
      { year: local.year, month: local.month, day: local.day - daysBack, hour: REPORT_HOUR },
      timeZone
    );

  let back = daysSinceMonday;
  let end = at(back);
  // Monday, but the hour has not come round yet: the last completed week
  // ended a week ago.
  if (end.getTime() > now.getTime()) {
    back += 7;
    end = at(back);
  }

  // The previous trigger, computed the same way rather than by subtracting
  // seven days of milliseconds. Twice a year those are not the same thing, and
  // the difference is a week that overlaps or skips an hour of its neighbour.
  return { start: at(back + 7), end };
};

/** A stable identifier for a window, used as the delivery key. */
export const windowKey = ({ start, end }) =>
  `${start.toISOString()}_${end.toISOString()}`;
