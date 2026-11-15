/** B5 (finding H12): one date format across the app, month first and in UTC. */
import { describe, expect, it } from "vitest";
import { fmtDay, fmtShortDay, fmtUtc } from "../src/lib/format";

describe("date format (B5)", () => {
  it("a day reads 'Jan 11, 2027' from a YYYY-MM-DD day, an ISO instant or epoch ms", () => {
    expect(fmtDay("2027-01-11")).toBe("Jan 11, 2027");
    expect(fmtDay("2027-01-01T00:00:00Z")).toBe("Jan 1, 2027"); // no zero padding
    expect(fmtDay(Date.parse("2026-12-29T23:59:00Z"))).toBe("Dec 29, 2026"); // UTC, not the machine's zone
  });

  it("inside a stay the year is dropped; an instant adds the UTC time", () => {
    expect(fmtShortDay("2027-01-26T20:30:00Z")).toBe("Jan 26");
    expect(fmtUtc(Date.parse("2027-01-16T14:00:00Z"))).toBe("Jan 16, 14:00 UTC");
  });
});
