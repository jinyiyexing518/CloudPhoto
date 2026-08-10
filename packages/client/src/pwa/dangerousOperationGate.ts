export interface DangerousOperationSnapshot {
  active: boolean;
  message: string;
}

const activities = new Map<string, string>();
const listeners = new Set<(snapshot: DangerousOperationSnapshot) => void>();

function snapshot(): DangerousOperationSnapshot {
  const first = activities.values().next();
  return {
    active: !first.done,
    message: first.done ? "" : first.value,
  };
}

function notify(): void {
  const current = snapshot();
  for (const listener of listeners) listener(current);
}

export function setDangerousOperationActivity(
  source: string,
  active: boolean,
  message: string,
): void {
  if (active) activities.set(source, message);
  else activities.delete(source);
  notify();
}

export function getDangerousOperationSnapshot(): DangerousOperationSnapshot {
  return snapshot();
}

export function subscribeDangerousOperation(
  listener: (snapshot: DangerousOperationSnapshot) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
