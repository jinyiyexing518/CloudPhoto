export interface RecentShareLink {
  id: string;
  photoName: string;
  displayName: string;
  url: string;
  expiresAt: string;
  createdAt: string;
}

const KEY = "cf_recent_share_links";
const MAX_ITEMS = 60;

function read(): RecentShareLink[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentShareLink[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => x && typeof x.id === "string" && typeof x.url === "string");
  } catch {
    return [];
  }
}

function write(items: RecentShareLink[]): void {
  localStorage.setItem(KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
}

export function listRecentShareLinks(): RecentShareLink[] {
  const now = Date.now();
  const items = read().filter((x) => {
    const expires = new Date(x.expiresAt).getTime();
    return Number.isFinite(expires) && expires > now;
  });
  write(items);
  return items;
}

export function addRecentShareLink(input: Omit<RecentShareLink, "id" | "createdAt">): void {
  const nowIso = new Date().toISOString();
  const item: RecentShareLink = {
    ...input,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: nowIso,
  };
  const prev = listRecentShareLinks().filter((x) => x.url !== input.url);
  write([item, ...prev]);
}

export function removeRecentShareLink(id: string): void {
  write(listRecentShareLinks().filter((x) => x.id !== id));
}

export function clearRecentShareLinks(): void {
  localStorage.removeItem(KEY);
}
