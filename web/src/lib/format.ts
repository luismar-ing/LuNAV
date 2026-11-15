/**
 * One way to write a date across the app (B5, finding H12): month first, in English, always in UTC.
 *   fmtDay      "Jan 11, 2027"            a day on its own (arrival, launch, day strip)
 *   fmtShortDay "Jan 11"                  a day inside a stay, where the year is already known
 *   fmtUtc      "Jan 16, 14:00 UTC"       an instant (sunset, Earthset, events)
 * Before this, the same day could read "01/01/2027" (system format), "Jan 01, 2027", "11 Jan" or "2027-01-11".
 */
const day = (ms: number, year: boolean) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });

const toMs = (t: string | number) => (typeof t === "number" ? t : Date.parse(t.length === 10 ? `${t}T00:00:00Z` : t));

/** "Jan 11, 2027" from epoch ms, an ISO instant or a YYYY-MM-DD day. */
export const fmtDay = (t: string | number): string => day(toMs(t), true);

/** "Jan 11" (no year). */
export const fmtShortDay = (t: string | number): string => day(toMs(t), false);

/** "Jan 16, 14:00 UTC". */
export function fmtUtc(ms: number): string {
  return `${fmtShortDay(ms)}, ${new Date(ms).toISOString().slice(11, 16)} UTC`;
}
