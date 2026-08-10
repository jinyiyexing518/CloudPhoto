export const BACKFILL_PAGE_SIZE = 200;

export interface BackfillCursor {
  token: string;
  after: string;
  context: string;
}

export function encodeBackfillCursor(cursor: BackfillCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeBackfillCursor(raw: string, expectedContext: string): BackfillCursor | null {
  if (!raw) return { token: "", after: "", context: expectedContext };
  try {
    const value = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<BackfillCursor>;
    if (
      typeof value.token !== "string"
      || typeof value.after !== "string"
      || value.context !== expectedContext
    ) {
      return null;
    }
    return { token: value.token, after: value.after, context: value.context };
  } catch {
    return null;
  }
}
