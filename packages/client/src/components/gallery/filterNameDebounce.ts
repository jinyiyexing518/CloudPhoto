export interface NameFilterState {
  name: string;
}

export interface FilterNameDebounceScheduler {
  set(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clear(handle: ReturnType<typeof setTimeout>): void;
}

interface FilterNameDebouncerOptions<T extends NameFilterState> {
  readFilters: () => T;
  readOnChange: () => (filters: T) => void;
  scheduler?: FilterNameDebounceScheduler;
  delayMs?: number;
}

export interface FilterNameDebouncer {
  schedule(name: string): void;
  cancel(): void;
}

const defaultScheduler: FilterNameDebounceScheduler = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle),
};

export function createFilterNameDebouncer<T extends NameFilterState>({
  readFilters,
  readOnChange,
  scheduler = defaultScheduler,
  delayMs = 300,
}: FilterNameDebouncerOptions<T>): FilterNameDebouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  const cancel = () => {
    generation += 1;
    if (timer !== null) {
      scheduler.clear(timer);
      timer = null;
    }
  };

  return {
    schedule(name) {
      cancel();
      const scheduledGeneration = generation;
      timer = scheduler.set(() => {
        if (generation !== scheduledGeneration) return;
        timer = null;
        readOnChange()({ ...readFilters(), name });
      }, delayMs);
    },
    cancel,
  };
}
