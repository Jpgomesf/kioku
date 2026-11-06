// One way to show dates on every page. A date-only string ("2026-11-04") is a calendar
// date and never shifts with the timezone; a full timestamp is shown in local time.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

interface Day {
  year: number;
  month: number;
  day: number;
}

function toDay(iso: string): Day | null {
  const only = DATE_ONLY.exec(iso);
  if (only) {
    const [, y, m, d] = only;
    const month = Number(m) - 1;
    if (month < 0 || month > 11) return null;
    return { year: Number(y), month, day: Number(d) };
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
