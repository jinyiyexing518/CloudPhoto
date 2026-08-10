interface ReconcileLocationIndexOptions {
  metadataChanged: boolean;
  sync: () => Promise<void>;
}

export interface ExistingGpsReconcileResult {
  metadataChanged: boolean;
  indexReconciled: boolean;
}

export async function reconcileLocationIndex({
  metadataChanged,
  sync,
}: ReconcileLocationIndexOptions): Promise<ExistingGpsReconcileResult> {
  try {
    await sync();
    return { metadataChanged, indexReconciled: true };
  } catch {
    return { metadataChanged, indexReconciled: false };
  }
}
