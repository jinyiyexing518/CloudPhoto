export interface ChangelogEntry {
  id: string;
  date: string;
  icon: string;
  title: string;
  desc: string;
  details?: string;
  type?: "feature" | "fix" | "improvement";
  seq?: number;
}

export interface ChangelogQueryRow {
  id: string;
  date: string;
  icon: string;
  title: string;
  description: string;
  details?: string;
  type?: "feature" | "fix" | "improvement";
  seq?: number;
  _ts?: number;
}

export const CHANGELOG_QUERY =
  'SELECT c.id, c.date, c.icon, c.title, c["desc"] AS description, c.details, c.type, c.seq, c._ts FROM c WHERE c.date >= @cutoff';

export function toChangelogEntries(
  queryRows: ChangelogQueryRow[]
): ChangelogEntry[] {
  return [...queryRows]
    .sort((a, b) => {
      const dateCmp = b.date.localeCompare(a.date);
      if (dateCmp !== 0) return dateCmp;
      if (a.seq != null && b.seq != null) return b.seq - a.seq;
      // Entries with a stable sequence sort ahead of legacy same-day entries.
      if (a.seq != null) return -1;
      if (b.seq != null) return 1;
      const tsCmp = (b._ts ?? 0) - (a._ts ?? 0);
      if (tsCmp !== 0) return tsCmp;
      return b.id.localeCompare(a.id);
    })
    .map((row) => ({
      id: row.id,
      date: row.date,
      icon: row.icon,
      title: row.title,
      desc: row.description,
      details: row.details,
      type: row.type,
      seq: row.seq,
    }));
}
