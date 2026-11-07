// One way to show dates on every page. A date-only string ("2026-11-04") is a calendar
// date and never shifts with the timezone; a full timestamp is shown in local time.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
// A full ISO timestamp with a time (and usually a zone), as the store and toISOString write them.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

interface Day {
  year: number;
  month: number;
  day: number;
}

function toDay(iso: string): Day | null {
  const only = DATE_ONLY.exec(iso);
  if (only) {
    const [, y, m, d] = only;
    const year = Number(y);
    const month = Number(m) - 1;
    const day = Number(d);
    // Round-trip so "2026-02-30" is rejected rather than rolled over to 2 Mar.
    const date = new Date(year, month, day);
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
      return null;
    }
    return { year, month, day };
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() };
}

/** "5 Nov", with the year when it isn't the current one; the input when it doesn't parse. */
export function formatDay(iso: string, now: Date = new Date()): string {
  const d = toDay(iso);
  if (!d) return iso;
  const day = `${d.day} ${MONTHS[d.month]}`;
  return d.year === now.getFullYear() ? day : `${day} ${d.year}`;
}

/** "5 Nov 18:02" in local time; a date-only string gives just the day. */
export function formatDayTime(iso: string, now: Date = new Date()): string {
  if (DATE_ONLY.test(iso)) return formatDay(iso, now);
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${formatDay(iso, now)} ${hh}:${mm}`;
}

/**
 * The instant a date or timestamp starts, in ms. A date-only string is local midnight, so
 * "since 5 Nov" starts when 5 Nov starts here; NaN for anything that isn't a real date or a
 * full ISO timestamp.
 */
export function parseInstant(iso: string): number {
  if (!DATE_ONLY.test(iso) && !TIMESTAMP.test(iso)) return Number.NaN;
  const d = toDay(iso);
  if (!d) return Number.NaN;
  return DATE_ONLY.test(iso) ? new Date(d.year, d.month, d.day).getTime() : Date.parse(iso);
}
