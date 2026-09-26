import {
  addCalendarDays,
  addWorkingDays,
  calendarWeeksBetween,
  mondayOf,
  weekdayOf,
} from "./zoned-time.util";

describe("addWorkingDays", () => {
  it("Monday + 4 working days = Friday", () => {
    // 2026-08-24 is a Monday.
    expect(addWorkingDays("2026-08-24", 4)).toBe("2026-08-28");
  });

  it("Friday + 4 working days = Thursday the following week", () => {
    // 2026-08-28 is a Friday.
    expect(addWorkingDays("2026-08-28", 4)).toBe("2026-09-03");
  });

  it("skips Saturday and Sunday entirely, not just a landing on them", () => {
    // 2026-08-26 is a Wednesday; +3 working days must cross the weekend
    // (Thu, Fri, then skip Sat/Sun, land Mon) rather than stopping at Sat.
    expect(addWorkingDays("2026-08-26", 3)).toBe("2026-08-31");
  });

  it("honors a custom working-weekdays set instead of the Mon-Fri default", () => {
    // Sequence configured with a 6-day week (Mon-Sat, Sunday off only).
    const sixDayWeek = [1, 2, 3, 4, 5, 6];
    // 2026-08-28 is a Friday; +1 working day lands Saturday under this config.
    expect(addWorkingDays("2026-08-28", 1, sixDayWeek)).toBe("2026-08-29");
  });
});

describe("mondayOf", () => {
  it("returns the same date for a Monday", () => {
    expect(mondayOf("2026-08-24")).toBe("2026-08-24");
  });

  it("returns the prior Monday for a mid-week date", () => {
    expect(mondayOf("2026-08-27")).toBe("2026-08-24");
  });

  it("returns the prior Monday for a Sunday", () => {
    expect(mondayOf("2026-08-30")).toBe("2026-08-24");
  });
});

describe("calendarWeeksBetween", () => {
  it("is 0 for two dates in the same calendar week", () => {
    expect(calendarWeeksBetween("2026-08-24", "2026-08-28")).toBe(0);
  });

  it("is 1 for dates one week apart", () => {
    expect(calendarWeeksBetween("2026-08-24", "2026-08-31")).toBe(1);
  });

  it("is 2 for dates two weeks apart", () => {
    expect(calendarWeeksBetween("2026-08-24", "2026-09-07")).toBe(2);
  });
});

describe("weekdayOf / addCalendarDays sanity", () => {
  it("agrees Saturday is 6 and Sunday is 0", () => {
    expect(weekdayOf("2026-08-29")).toBe(6);
    expect(weekdayOf("2026-08-30")).toBe(0);
  });

  it("addCalendarDays does not skip weekends", () => {
    expect(addCalendarDays("2026-08-28", 4)).toBe("2026-09-01");
  });
});
