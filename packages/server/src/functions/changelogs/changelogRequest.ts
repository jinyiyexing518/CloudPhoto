const DEFAULT_CHANGELOG_DAYS = 30;
const MAX_CHANGELOG_DAYS = 365;

export function parseChangelogDays(daysParam: string | null): number {
  if (daysParam === null) {
    return DEFAULT_CHANGELOG_DAYS;
  }

  const days = Number(daysParam);
  if (!Number.isInteger(days) || days <= 0) {
    return DEFAULT_CHANGELOG_DAYS;
  }

  return Math.min(days, MAX_CHANGELOG_DAYS);
}
