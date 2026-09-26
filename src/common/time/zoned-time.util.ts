// template_grouptbl.timezone holds IANA names, which Intl takes directly. An
// unusable value would throw, so these fall back instead of stalling a whole
// sequence; callers that care can log off the `fellBack` flag.
export const DEFAULT_TIME_ZONE = "Asia/Kolkata";

function partsIn(date: Date, timeZone: string): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
}

export interface ZonedClock {
  // Wall-clock calendar date in the zone, as YYYY-MM-DD.
  date: string;
  // Wall-clock hour in the zone, 0-23.
  hour: number;
  fellBack: boolean;
}

export function zonedAt(date: Date, timeZone: string): ZonedClock {
  let parts: Intl.DateTimeFormatPart[];
  let fellBack = false;

  try {
    parts = partsIn(date, timeZone);
  } catch {
    parts = partsIn(date, DEFAULT_TIME_ZONE);
    fellBack = true;
  }

  const valueOf = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return {
    date: `${valueOf("year")}-${valueOf("month")}-${valueOf("day")}`,
    hour: parseInt(valueOf("hour"), 10),
    fellBack,
  };
}

export function zonedNow(timeZone: string): ZonedClock {
  return zonedAt(new Date(), timeZone);
}

// Calendar arithmetic on YYYY-MM-DD, done at UTC midnight so a DST transition
// in the sequence's own zone can't shift the result by a day.
export function addCalendarDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
}

// 0 = Sunday ... 6 = Saturday, matching MySQL DAYOFWEEK() - 1.
export function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

// template_grouptbl.working_days ("1,2,3,4,5") holds which weekdays count as
// working days for a sequence, in the same 0=Sunday...6=Saturday numbering as
// weekdayOf. Every group in production is Mon-Fri today, so this is what
// callers should fall back to for a missing/unparsable value.
export const DEFAULT_WORKING_WEEKDAYS = [1, 2, 3, 4, 5];

// Walks forward one calendar day at a time, only counting down days that fall
// on a working weekday - the only way to get "Friday + 4 working days =
// Thursday next week" right, since a fixed offset can't know how many
// non-working days it will cross.
export function addWorkingDays(
  isoDate: string,
  workingDaysToAdd: number,
  workingWeekdays: number[] = DEFAULT_WORKING_WEEKDAYS,
): string {
  let date = isoDate;
  let remaining = workingDaysToAdd;

  while (remaining > 0) {
    date = addCalendarDays(date, 1);
    if (workingWeekdays.includes(weekdayOf(date))) {
      remaining--;
    }
  }

  return date;
}

// The Monday of isoDate's own calendar week - the fixed point a sequence's
// weekly domain rotation counts from, independent of which days that sequence
// treats as working days.
export function mondayOf(isoDate: string): string {
  const weekday = weekdayOf(isoDate);
  const offsetToMonday = weekday === 0 ? -6 : 1 - weekday;
  return addCalendarDays(isoDate, offsetToMonday);
}

// How many Monday-to-Monday week boundaries lie between two dates - 0 for two
// dates in the same calendar week, 1 for adjacent weeks, and so on. Negative
// if toIsoDate is before fromIsoDate's week.
export function calendarWeeksBetween(
  fromIsoDate: string,
  toIsoDate: string,
): number {
  const fromMonday = Date.parse(`${mondayOf(fromIsoDate)}T00:00:00Z`);
  const toMonday = Date.parse(`${mondayOf(toIsoDate)}T00:00:00Z`);
  return Math.floor((toMonday - fromMonday) / (7 * 86_400_000));
}
