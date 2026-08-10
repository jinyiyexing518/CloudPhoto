export type AuthRole = "admin" | "viewer";

export interface AuthIdentity {
  userId: string;
  role: AuthRole;
}

export interface AuthorizationSnapshot extends AuthIdentity {
  token: string;
  cacheOwner: string;
}

export function authCacheOwner(userId: string, role: AuthRole): string {
  return `${encodeURIComponent(userId)}:${role}`;
}

export function decodeAuthorizationSnapshot(token: string | null): AuthorizationSnapshot | null {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const normalized = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const decoded = JSON.parse(atob(normalized)) as {
      userId?: unknown;
      role?: unknown;
    };
    if (
      typeof decoded.userId !== "string"
      || (decoded.role !== "admin" && decoded.role !== "viewer")
    ) {
      return null;
    }
    return {
      token,
      userId: decoded.userId,
      role: decoded.role,
      cacheOwner: authCacheOwner(decoded.userId, decoded.role),
    };
  } catch {
    return null;
  }
}
