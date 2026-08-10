export interface LocationSearchRequest {
  generation: number;
  signal: AbortSignal;
}

export interface LocationSearchRequestLifecycle {
  begin(): LocationSearchRequest;
  invalidate(reason?: string): void;
  isCurrent(request: LocationSearchRequest): boolean;
}

export function createLocationSearchRequestLifecycle(): LocationSearchRequestLifecycle {
  let generation = 0;
  let controller: AbortController | null = null;

  const abortActive = (reason: string) => {
    controller?.abort(new DOMException(reason, "AbortError"));
    controller = null;
  };

  return {
    begin() {
      abortActive("Superseded location search");
      controller = new AbortController();
      return {
        generation: ++generation,
        signal: controller.signal,
      };
    },
    invalidate(reason = "Location search invalidated") {
      generation += 1;
      abortActive(reason);
    },
    isCurrent(request) {
      return request.generation === generation && !request.signal.aborted;
    },
  };
}
