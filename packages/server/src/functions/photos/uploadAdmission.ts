export interface UploadAdmissionConfig {
  instanceMaxWeight: number;
  userMaxWeight: number;
  instanceMaxDeclaredBytes: number;
  userMaxDeclaredBytes: number;
  retryAfterSeconds: number;
  maxTrackedUsers?: number;
}

export interface UploadAdmissionLease {
  release: () => void;
}

export type UploadAdmissionDecision =
  | { accepted: true; lease: UploadAdmissionLease }
  | { accepted: false; retryAfterSeconds: number };

export type UploadLengthReservation =
  | { kind: "too-large"; declaredBytes: number }
  | { kind: "invalid"; reason: "missing" | "invalid" }
  | { kind: "accepted"; declaredBytes: number | null; reservationBytes: number };

interface UserAdmissionState {
  weight: number;
  declaredBytes: number;
}

export const uploadAdmissionLimits: UploadAdmissionConfig = {
  instanceMaxWeight: 3,
  userMaxWeight: 3,
  instanceMaxDeclaredBytes: 256 * 1024 * 1024,
  userMaxDeclaredBytes: 220 * 1024 * 1024,
  retryAfterSeconds: 3,
  maxTrackedUsers: 1_024,
};

export function resolveUploadLengthReservation(
  rawContentLength: string | null,
  maxBytes: number,
): UploadLengthReservation {
  const normalized = rawContentLength?.trim();
  if (!normalized) return { kind: "invalid", reason: "missing" };
  const valid = normalized !== undefined
    && /^\d+$/.test(normalized)
    && Number.isSafeInteger(Number(normalized));
  if (!valid) {
    return { kind: "invalid", reason: "invalid" };
  }
  const declaredBytes = Number(normalized);
  if (declaredBytes > maxBytes) return { kind: "too-large", declaredBytes };
  return { kind: "accepted", declaredBytes, reservationBytes: declaredBytes };
}

export function validateBufferedUploadLength(
  actualBytes: number,
  maxBytes: number,
  declaredBytes?: number,
): boolean {
  return Number.isSafeInteger(actualBytes)
    && actualBytes >= 0
    && actualBytes <= maxBytes
    && (declaredBytes === undefined || actualBytes === declaredBytes);
}

export function getUploadAdmissionWeight(
  isVideoUpload: boolean,
  reservationBytes: number,
): number {
  return isVideoUpload || reservationBytes > 20 * 1024 * 1024 ? 2 : 1;
}

export class UploadAdmissionController {
  private readonly config: Required<UploadAdmissionConfig>;
  private readonly users = new Map<string, UserAdmissionState>();
  private activeWeight = 0;
  private activeDeclaredBytes = 0;

  constructor(config: UploadAdmissionConfig) {
    this.config = {
      ...config,
      maxTrackedUsers: config.maxTrackedUsers ?? 1_024,
    };
  }

  tryAcquire(
    userId: string,
    weight: number,
    declaredBytes: number,
  ): UploadAdmissionDecision {
    const normalizedWeight = Math.max(1, Math.floor(weight));
    const normalizedBytes = Math.max(0, Math.floor(declaredBytes));
    const currentUser = this.users.get(userId);
    if (
      (!currentUser && this.users.size >= this.config.maxTrackedUsers)
      || this.activeWeight + normalizedWeight > this.config.instanceMaxWeight
      || this.activeDeclaredBytes + normalizedBytes > this.config.instanceMaxDeclaredBytes
      || (currentUser?.weight ?? 0) + normalizedWeight > this.config.userMaxWeight
      || (currentUser?.declaredBytes ?? 0) + normalizedBytes > this.config.userMaxDeclaredBytes
    ) {
      return {
        accepted: false,
        retryAfterSeconds: this.config.retryAfterSeconds,
      };
    }

    const userState = currentUser ?? { weight: 0, declaredBytes: 0 };
    userState.weight += normalizedWeight;
    userState.declaredBytes += normalizedBytes;
    this.users.set(userId, userState);
    this.activeWeight += normalizedWeight;
    this.activeDeclaredBytes += normalizedBytes;
    let released = false;
    return {
      accepted: true,
      lease: {
        release: () => {
          if (released) return;
          released = true;
          this.activeWeight -= normalizedWeight;
          this.activeDeclaredBytes -= normalizedBytes;
          userState.weight -= normalizedWeight;
          userState.declaredBytes -= normalizedBytes;
          if (userState.weight === 0) this.users.delete(userId);
        },
      },
    };
  }

  snapshot(): {
    activeWeight: number;
    activeDeclaredBytes: number;
    userCount: number;
  } {
    return {
      activeWeight: this.activeWeight,
      activeDeclaredBytes: this.activeDeclaredBytes,
      userCount: this.users.size,
    };
  }
}

export const uploadAdmission = new UploadAdmissionController(uploadAdmissionLimits);
