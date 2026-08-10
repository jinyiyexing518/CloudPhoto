export interface DangerousOperationSnapshot {
  active: boolean;
  message: string;
}

export interface DangerousOperationFacts {
  upload: boolean;
  download: boolean;
  deletion: boolean;
  voice: boolean;
  batchMutation: boolean;
  trashMutation: boolean;
  maintenance: boolean;
  folderRename: boolean;
}

const activities = new Map<string, string>();
const listeners = new Set<(snapshot: DangerousOperationSnapshot) => void>();

export function hasDangerousOperation(facts: DangerousOperationFacts): boolean {
  return facts.upload
    || facts.download
    || facts.deletion
    || facts.voice
    || facts.batchMutation
    || facts.trashMutation
    || facts.maintenance
    || facts.folderRename;
}

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
