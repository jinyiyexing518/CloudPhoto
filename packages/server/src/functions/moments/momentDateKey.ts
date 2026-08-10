const MINIMUM_TIMEZONE_OFFSET_HOURS = -12;
const MAXIMUM_TIMEZONE_OFFSET_HOURS = 14;

function utcDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function normalizeLocalDateKey(
  value: string | undefined,
  reference = new Date(),
): string | null {
  const normalized = value?.trim();
  const match = normalized?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!normalized || !match || Number.isNaN(reference.getTime())) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dateIndex = Date.UTC(year, month - 1, day);
  const date = new Date(dateIndex);
  const isValid = date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
  const earliestLocalDate = utcDateKey(
    reference.getTime() + MINIMUM_TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000,
  );
  const latestLocalDate = utcDateKey(
    reference.getTime() + MAXIMUM_TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000,
  );
  return isValid
    && normalized >= earliestLocalDate
    && normalized <= latestLocalDate
    ? normalized
    : null;
}
