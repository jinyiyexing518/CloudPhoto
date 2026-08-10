const PHOTO_LOCALE = "zh-CN";
const MILLISECONDS_PER_DAY = 86_400_000;

type PhotoDateValue = string | number | Date;

function canonicalDateParts(value: string): RegExpMatchArray | null {
  return value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/,
  );
}

function hasValidCalendarDate(parts: RegExpMatchArray): boolean {
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  const calendarMatches = calendarDate.getUTCFullYear() === year
    && calendarDate.getUTCMonth() === month - 1
    && calendarDate.getUTCDate() === day;
  const timeMatches = hourText === undefined || (
    Number(hourText) <= 23
    && Number(minuteText) <= 59
    && (secondText === undefined || Number(secondText) <= 59)
  );
  return calendarMatches && timeMatches;
}

function validDate(value: PhotoDateValue): Date | null {
  if (value === "") return null;
  let parsedValue = value;
  if (typeof value === "string") {
    const parts = canonicalDateParts(value);
    if (!parts || !hasValidCalendarDate(parts)) return null;
    if (!value.includes("T")) parsedValue = `${value}T12:00:00`;
  }
  const date = parsedValue instanceof Date ? parsedValue : new Date(parsedValue);
  return Number.isNaN(date.getTime()) ? null : date;
}

function format(
  value: PhotoDateValue,
  options: Intl.DateTimeFormatOptions,
): string {
  const date = validDate(value);
  return date ? date.toLocaleString(PHOTO_LOCALE, options) : "";
}

export function formatPhotoGroupDate(dateKey: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return "";
  return format(`${dateKey}T12:00:00`, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function getLocalCalendarDateKey(value: PhotoDateValue): string {
  const normalized = typeof value === "string" ? value.trim() : value;
  if (typeof normalized === "string" && /^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return validDate(normalized) ? normalized : "";
  }
  const date = validDate(normalized);
  if (!date) return "";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function getFirstLocalCalendarDateKey(
  ...values: Array<PhotoDateValue | null | undefined>
): string {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const dateKey = getLocalCalendarDateKey(value);
    if (dateKey) return dateKey;
  }
  return "";
}

export function getPhotoCalendarDayDistance(
  targetDateKey: string,
  reference: PhotoDateValue = new Date(),
): number | null {
  const target = validDate(targetDateKey);
  const current = validDate(reference);
  if (!target || !current) return null;
  const calendarIndex = (date: Date) =>
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round(
    (calendarIndex(target) - calendarIndex(current)) / MILLISECONDS_PER_DAY,
  );
}

export function formatPhotoDate(value: PhotoDateValue): string {
  return format(value, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatPhotoLongDate(value: PhotoDateValue): string {
  return format(value, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function formatPhotoMonthDay(value: PhotoDateValue): string {
  return format(value, {
    month: "long",
    day: "numeric",
  });
}

export function formatPhotoDateTime(value: PhotoDateValue): string {
  return format(value, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatPhotoDateTimeSeconds(value: PhotoDateValue): string {
  return format(value, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
