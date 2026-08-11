(() => {
  const messageType = "cloudphoto-private-cache-fence";
  const stateCacheName = "cloudphoto-private-cache-fence-v1";
  const stateRequest = new Request(
    new URL("/__cloudphoto_private_cache_fence_state__", self.location.origin),
  );
  let generation = 0;
  let enabled = false;
  let cleanupActive = false;

  const publish = () => {
    self.__cloudPhotoPrivateCacheGeneration = generation;
    self.__cloudPhotoPrivateCacheEnabled = enabled;
  };

  const persist = async () => {
    const cache = await caches.open(stateCacheName);
    await cache.put(stateRequest, new Response(JSON.stringify({
      generation,
      enabled,
      cleanupActive,
    }), {
      headers: { "Content-Type": "application/json" },
    }));
  };
  const clearPersistedState = async () => {
    try {
      const cache = await caches.open(stateCacheName);
      await cache.delete(stateRequest);
    } catch {
      // The command still fails and the current worker remains fail closed.
    }
  };
  const stateReady = (async () => {
    try {
      const cache = await caches.open(stateCacheName);
      const stored = await cache.match(stateRequest);
      if (stored) {
        const state = await stored.json();
        if (
          Number.isSafeInteger(state?.generation)
          && state.generation >= 0
          && typeof state.enabled === "boolean"
          && typeof state.cleanupActive === "boolean"
        ) {
          generation = state.generation;
          enabled = state.enabled;
          cleanupActive = state.cleanupActive;
        }
      }
    } catch {
      generation = 0;
      enabled = false;
      cleanupActive = false;
    }
    publish();
  })();
  self.__cloudPhotoPrivateCacheFenceReady = stateReady;

  const handleCommand = async (event) => {
    const reply = event.ports[0];
    let ok = false;
    if (event.data.command === "begin") {
      generation += 1;
      enabled = false;
      cleanupActive = true;
      ok = true;
    } else if (event.data.command === "enable") {
      if (!cleanupActive) {
        generation += 1;
        enabled = true;
        ok = true;
      }
    } else {
      ok = (
        (event.data.command === "resume" || event.data.command === "complete")
        && event.data.generation === generation
        && cleanupActive
      );
      if (ok) {
        enabled = event.data.command === "resume";
        cleanupActive = false;
      }
    }
    const enablesWrites = ok && enabled;
    if (!enablesWrites) publish();
    try {
      await persist();
      if (enablesWrites) publish();
    } catch {
      enabled = false;
      cleanupActive = true;
      publish();
      await clearPersistedState();
      ok = false;
    }
    try {
      reply?.postMessage({ ok, generation });
    } catch {
      // The persisted fail-closed state remains authoritative if the tab left.
    }
  };

  let commandChain = stateReady;
  self.addEventListener("message", (event) => {
    if (event.data?.type !== messageType) return;
    commandChain = commandChain.then(
      () => handleCommand(event),
      () => handleCommand(event),
    );
    event.waitUntil(commandChain);
  });
})();
