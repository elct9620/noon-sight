import { describe, expect, it, vi } from "vitest";
import {
  CURRENT,
  PREVIOUS,
  instants,
  settled,
  windows,
  yesterday,
} from "../src/period";

describe("windows", () => {
  it("ends the requested window on the anchor and spans it inclusively", () => {
    expect(windows("2026-08-09", 28)).toEqual([
      { name: CURRENT, startDate: "2026-07-13", endDate: "2026-08-09" },
      { name: PREVIOUS, startDate: "2026-06-15", endDate: "2026-07-12" },
    ]);
  });

  // The two windows have to abut without overlapping: a day counted in both
  // would show up as growth the site never had.
  it("ends the previous window the day before this one starts", () => {
    expect(windows("2026-03-02", 7)).toEqual([
      { name: CURRENT, startDate: "2026-02-24", endDate: "2026-03-02" },
      { name: PREVIOUS, startDate: "2026-02-17", endDate: "2026-02-23" },
    ]);
  });

  // Counting in days rather than in calendar arithmetic is what makes a month
  // boundary uneventful.
  it("crosses a month boundary by day count", () => {
    expect(windows("2026-03-01", 1)).toEqual([
      { name: CURRENT, startDate: "2026-03-01", endDate: "2026-03-01" },
      { name: PREVIOUS, startDate: "2026-02-28", endDate: "2026-02-28" },
    ]);
  });
});

describe("yesterday", () => {
  // A source counting at the edge has nothing to wait for, and the week it
  // keeps is too short to spend three days of it waiting on another source.
  it("stops at the last whole day rather than at the shared anchor", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T09:00:00Z"));

    expect(yesterday()).toBe("2026-08-11");

    vi.useRealTimers();
  });
});

describe("instants", () => {
  // Both ends of a window are inclusive days, and a source filtering on
  // instants excludes its upper bound — so the last day is only counted when
  // the range runs to the midnight after it.
  it("runs to the midnight after the day the window ends on", () => {
    expect(
      instants({ startDate: "2026-08-09", endDate: "2026-08-11" }),
    ).toEqual({
      from: Date.parse("2026-08-09T00:00:00Z"),
      to: Date.parse("2026-08-12T00:00:00Z"),
    });
  });
});

describe("settled", () => {
  // Search Console finalises a day about three days later, so a window ending
  // yesterday would report a current period that is still being counted and
  // read as a collapse against a complete one.
  it("stops where a source is expected to have finished counting", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T09:00:00Z"));

    expect(settled()).toBe("2026-08-09");

    vi.useRealTimers();
  });
});
