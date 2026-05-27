import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET as string;

export interface TokenPayload {
  userId: string;
  username: string;
  displayName: string;
  role: string;
}

/** Short-lived access token — 2 hours */
export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "2h" });
}

/** Long-lived refresh token — 30 days, distinguished by tokenType claim */
export function signRefreshToken(payload: TokenPayload): string {
  return jwt.sign({ ...payload, tokenType: "refresh" }, JWT_SECRET, { expiresIn: "30d" });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch {
    return null;
  }
}

/** Verify a refresh token — rejects regular access tokens */
export function verifyRefreshToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as TokenPayload & { tokenType?: string };
    if (decoded.tokenType !== "refresh") return null;
    const { tokenType: _, iat: _i, exp: _e, ...payload } = decoded as unknown as Record<string, unknown>;
    return payload as unknown as TokenPayload;
  } catch {
    return null;
  }
}

export function extractTokenFromHeader(authHeader: string | null): TokenPayload | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return verifyToken(authHeader.slice(7));
}
