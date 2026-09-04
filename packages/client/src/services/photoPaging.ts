export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  done: boolean;
  revision: number;
  total: number;
}

export interface PagedCollectionProgress<T> {
  items: T[];
  complete: boolean;
  loaded: number;
  total: number;
  revision: number;
}

export class PhotoPaginationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoPaginationError";
  }
}

function validatePage<T>(page: CursorPage<T>): void {
  if (
    !page
    || !Array.isArray(page.items)
    || typeof page.done !== "boolean"
    || !Number.isSafeInteger(page.revision)
    || page.revision < 0
    || !Number.isSafeInteger(page.total)
    || page.total < 0
    || (page.nextCursor !== null && typeof page.nextCursor !== "string")
  ) {
    throw new PhotoPaginationError("Invalid photo page response");
  }
}

export async function loadPagedCollection<T>(input: {
  fetchPage: (cursor: string | null) => Promise<CursorPage<T>>;
  keyOf: (item: T) => string;
  assertCurrent?: () => void;
  onProgress?: (progress: PagedCollectionProgress<T>) => void;
  maxPages?: number;
}): Promise<T[]> {
  const items: T[] = [];
  const indexByKey = new Map<string, number>();
  const maxPages = input.maxPages ?? 10_000;
  let cursor: string | null = null;
  let revision: number | null = null;
  let total: number | null = null;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    input.assertCurrent?.();
    const page = await input.fetchPage(cursor);
    input.assertCurrent?.();
    validatePage(page);

    if (revision === null) {
      revision = page.revision;
      total = page.total;
    } else if (page.revision !== revision) {
      throw new PhotoPaginationError(
        `Photo catalog revision changed from ${revision} to ${page.revision}`,
      );
    } else if (page.total !== total) {
      throw new PhotoPaginationError(
        `Photo catalog total changed from ${total} to ${page.total}`,
      );
    }

    for (const item of page.items) {
      const key = input.keyOf(item);
      if (!key) throw new PhotoPaginationError("Photo page item is missing a stable key");
      const existingIndex = indexByKey.get(key);
      if (existingIndex === undefined) {
        indexByKey.set(key, items.length);
        items.push(item);
      } else {
        items[existingIndex] = item;
      }
    }

    if (page.done) {
      if (page.nextCursor !== null) {
        throw new PhotoPaginationError("Completed photo page must not return a cursor");
      }
      if (items.length !== total) {
        throw new PhotoPaginationError(
          `Photo pagination expected ${total} items but received ${items.length}`,
        );
      }
    } else if (
      !page.nextCursor
      || page.nextCursor === cursor
      || page.items.length === 0
    ) {
      throw new PhotoPaginationError("Photo pagination cursor must advance");
    }

    input.onProgress?.({
      items: [...items],
      complete: page.done,
      loaded: items.length,
      total: total!,
      revision,
    });

    if (page.done) return items;
    cursor = page.nextCursor;
  }

  throw new PhotoPaginationError(`Photo pagination exceeded ${maxPages} pages`);
}
