(() => {
  const messageType = "cloudphoto-private-cache-fence";
  const stateCacheName = "cloudphoto-private-cache-fence-v1";
  const mediaCacheName = "photo-media-v1";
  const mediaCacheGenerationParam = "__cf_private_generation";
  const mediaCacheGenerationHeader = "x-cloudphoto-private-cache-generation";
  const mediaCachedAtHeader = "x-cloudphoto-private-cached-at";
  const mediaCacheMaxAgeMs = 60 * 60 * 1000;
  const mediaCacheMaxEntries = 600;
  const mediaCacheDeadlineMs = 750;
  const stateRequest = new Request(
    new URL("/__cloudphoto_private_cache_fence_state__", self.location.origin),
  );
  const stateRequestPath = stateRequest.url;
  let generation = 0;
  let enabled = false;
  let cleanupActive = false;
  let stateRestored = false;
  let stateVersion = 0;
  let resumeGenerationOnEnable = false;
  let commandEpoch = 0;
  const pendingBeginContexts = [];

  const publish = () => {
    self.__cloudPhotoPrivateCacheGeneration = generation;
    self.__cloudPhotoPrivateCacheEnabled = enabled;
  };
  publish();

  const stateVersionRequest = (version) => {
    const url = new URL(stateRequestPath);
    url.searchParams.set("version", String(version));
    return new Request(url);
  };
  const validState = (state, version) => (
    Number.isSafeInteger(state?.generation)
    && state.generation >= 0
    && typeof state.enabled === "boolean"
    && typeof state.cleanupActive === "boolean"
    && !(state.enabled && state.cleanupActive)
    && Number.isSafeInteger(version)
    && version >= 0
    && (state.version === undefined || state.version === version)
  );
  const persist = async (nextState) => {
    const cache = await caches.open(stateCacheName);
    await cache.put(stateVersionRequest(nextState.version), new Response(JSON.stringify({
      generation: nextState.generation,
      enabled: nextState.enabled,
      cleanupActive: nextState.cleanupActive,
      version: nextState.version,
    }), {
      headers: { "Content-Type": "application/json" },
    }));
  };
  const clearPersistedState = async (throughVersion) => {
    try {
      const cache = await caches.open(stateCacheName);
      const keys = await cache.keys();
      const staleKeys = keys.filter((request) => {
        const url = new URL(request.url);
        if (url.origin + url.pathname !== stateRequestPath) return false;
        const value = url.searchParams.get("version");
        if (value === null) return true;
        if (!/^(?:0|[1-9]\d*)$/.test(value)) return false;
        const version = Number(value);
        return Number.isSafeInteger(version) && version <= throughVersion;
      });
      await Promise.all(staleKeys.map((request) => cache.delete(request)));
    } catch {
      // The command still fails and the current worker remains fail closed.
    }
  };
  const restore = async () => {
    const cache = await caches.open(stateCacheName);
    const storedVersions = (await cache.keys())
      .map((request) => {
        const url = new URL(request.url);
        if (url.origin + url.pathname !== stateRequestPath) return null;
        const value = url.searchParams.get("version");
        if (value === null || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
        const version = Number(value);
        return Number.isSafeInteger(version) ? { request, version } : null;
      })
      .filter(Boolean)
      .sort((left, right) => right.version - left.version);
    const latestObservedVersion = storedVersions[0]?.version ?? 0;
    for (const candidate of storedVersions) {
      try {
        const stored = await cache.match(candidate.request);
        if (!stored) continue;
        const state = await stored.json();
        if (!validState(state, candidate.version)) continue;
        generation = state.generation;
        enabled = false;
        cleanupActive = state.cleanupActive;
        stateVersion = latestObservedVersion;
        resumeGenerationOnEnable = state.enabled && !state.cleanupActive;
        return;
      } catch {
        // A damaged newer record must not hide the last valid fail-closed state.
      }
    }
    stateVersion = latestObservedVersion;
    try {
      const legacy = await cache.match(stateRequest);
      if (!legacy) return;
      const state = await legacy.json();
      if (validState(state, 0)) {
        generation = state.generation;
        enabled = false;
        cleanupActive = state.cleanupActive;
        resumeGenerationOnEnable = state.enabled && !state.cleanupActive;
      }
    } catch {
      // A damaged legacy record cannot lower the observed immutable version.
    }
  };
  const applyBegin = (context) => {
    generation += 1;
    stateVersion += 1;
    enabled = false;
    cleanupActive = true;
    resumeGenerationOnEnable = false;
    publish();
    context.assignedGeneration = generation;
    context.assignedVersion = stateVersion;
    context.preappliedBegin = true;
    context.persistence = persist({
      generation,
      enabled,
      cleanupActive,
      version: stateVersion,
    }).catch(async () => {
      context.persistenceFailed = true;
      await clearPersistedState(context.assignedVersion);
    });
  };
  const stateReady = (async () => {
    try {
      await restore();
    } catch {
      generation = 0;
      enabled = false;
      cleanupActive = false;
      stateVersion = 0;
    }
    while (pendingBeginContexts.length > 0) {
      const contexts = pendingBeginContexts.splice(0);
      for (const context of contexts) applyBegin(context);
      await Promise.all(contexts.map((context) => context.persistence));
    }
    stateRestored = true;
    publish();
  })();
  self.__cloudPhotoPrivateCacheFenceReady = stateReady;

  const mediaCacheKey = (request, snapshot) => {
    const url = new URL(request.url);
    url.searchParams.delete("cf_cover");
    url.searchParams.delete("cf_cover_retry");
    url.searchParams.set(mediaCacheGenerationParam, String(snapshot.generation));
    return new Request(url, request);
  };
  const mediaSnapshotCurrent = (snapshot) => (
    snapshot?.ready === true
    && stateRestored
    && snapshot?.enabled === true
    && enabled === true
    && cleanupActive === false
    && snapshot.generation === generation
  );
  const withMediaCacheDeadline = (operation, label) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const error = new Error(`Private media cache ${label} timed out`);
      error.name = "TimeoutError";
      reject(error);
    }, mediaCacheDeadlineMs);
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
  const reportMediaCacheFailure = (label, error) => {
    console.warn("[PrivateMediaCache]", {
      label,
      generation,
      errorType: error instanceof Error ? error.name : typeof error,
    });
  };
  const purgeStaleMediaGenerations = async () => {
    const cache = await caches.open(mediaCacheName);
    const keys = await cache.keys();
    const staleKeys = keys.filter((request) => {
      const storedGeneration = Number(
        new URL(request.url).searchParams.get(mediaCacheGenerationParam),
      );
      return !Number.isSafeInteger(storedGeneration) || storedGeneration !== generation;
    });
    await Promise.all(staleKeys.map((request) => cache.delete(request)));
  };
  const privateMediaCachePolicy = {
    snapshot() {
      return { generation, enabled, ready: stateRestored };
    },
    current(snapshot) {
      return mediaSnapshotCurrent(snapshot);
    },
    accepts(response, snapshot) {
      const cachedGenerationValue = response.headers.get(mediaCacheGenerationHeader);
      const cachedAtValue = response.headers.get(mediaCachedAtHeader);
      if (
        cachedGenerationValue === null
        || cachedAtValue === null
        || !/^(?:0|[1-9]\d*)$/.test(cachedGenerationValue)
        || !/^(?:0|[1-9]\d*)$/.test(cachedAtValue)
      ) {
        return false;
      }
      const cachedGeneration = Number(cachedGenerationValue);
      const cachedAt = Number(cachedAtValue);
      const age = Date.now() - cachedAt;
      return mediaSnapshotCurrent(snapshot)
        && Number.isSafeInteger(cachedGeneration)
        && cachedGeneration === snapshot.generation
        && Number.isSafeInteger(cachedAt)
        && age >= 0
        && age <= mediaCacheMaxAgeMs;
    },
    async read(request, snapshot) {
      if (snapshot?.ready !== true) {
        try {
          await withMediaCacheDeadline(stateReady, "state restore");
        } catch (error) {
          reportMediaCacheFailure("state restore", error);
        }
        return null;
      }
      if (!mediaSnapshotCurrent(snapshot)) return null;
      const operation = (async () => {
        const cache = await caches.open(mediaCacheName);
        if (!mediaSnapshotCurrent(snapshot)) return null;
        const key = mediaCacheKey(request, snapshot);
        const cached = await cache.match(key);
        if (!cached || !mediaSnapshotCurrent(snapshot)) return null;
        if (!privateMediaCachePolicy.accepts(cached, snapshot)) {
          await cache.delete(key);
          return null;
        }
        return cached;
      })();
      try {
        return await withMediaCacheDeadline(operation, "read");
      } catch (error) {
        reportMediaCacheFailure("read", error);
        return null;
      }
    },
    async write(request, response, snapshot) {
      if (!mediaSnapshotCurrent(snapshot) || response.status !== 200) return false;
      const operation = (async () => {
        const cache = await caches.open(mediaCacheName);
        if (!mediaSnapshotCurrent(snapshot)) return false;
        const key = mediaCacheKey(request, snapshot);
        const headers = new Headers(response.headers);
        headers.set(mediaCacheGenerationHeader, String(snapshot.generation));
        headers.set(mediaCachedAtHeader, String(Date.now()));
        await cache.put(key, new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        }));
        if (!mediaSnapshotCurrent(snapshot)) {
          await cache.delete(key);
          return false;
        }
        const keys = await cache.keys();
        await Promise.all(
          keys.slice(0, Math.max(0, keys.length - mediaCacheMaxEntries))
            .map((oldest) => cache.delete(oldest)),
        );
        return true;
      })();
      try {
        return await withMediaCacheDeadline(operation, "write");
      } catch (error) {
        reportMediaCacheFailure("write", error);
        return false;
      }
    },
    async cleanup() {
      try {
        await withMediaCacheDeadline(
          purgeStaleMediaGenerations(),
          "generation cleanup",
        );
        return true;
      } catch (error) {
        reportMediaCacheFailure("generation cleanup", error);
        return false;
      }
    },
  };
  self.__cloudPhotoPrivateMediaCachePolicy = privateMediaCachePolicy;
  void stateReady.then(() => privateMediaCachePolicy.cleanup());

  const handleCommand = async (event, context) => {
    const reply = event.ports[0];
    let ok = false;
    if (context.expiredAtArrival) {
      try {
        reply?.postMessage({ ok, generation });
      } catch {
        // The unchanged fail-closed state remains authoritative if the tab left.
      }
      return;
    }
    if (context.preappliedBegin) {
      await context.persistence;
      ok = context.persistenceFailed !== true;
      if (ok) void privateMediaCachePolicy.cleanup();
      try {
        reply?.postMessage({ ok, generation: context.assignedGeneration });
      } catch {
        // The persisted fail-closed state remains authoritative if the tab left.
      }
      return;
    }
    let nextGeneration = generation;
    let nextEnabled = enabled;
    let nextCleanupActive = cleanupActive;
    if (event.data.command === "enable") {
      if (!nextCleanupActive) {
        if (!nextEnabled && !resumeGenerationOnEnable) nextGeneration += 1;
        nextEnabled = true;
        ok = true;
      }
    } else {
      ok = (
        (event.data.command === "resume" || event.data.command === "complete")
        && event.data.generation === generation
        && cleanupActive
      );
      if (ok) {
        nextEnabled = event.data.command === "resume";
        nextCleanupActive = false;
      }
    }
    const stateChanged = (
      nextGeneration !== generation
      || nextEnabled !== enabled
      || nextCleanupActive !== cleanupActive
    );
    if (!stateChanged) {
      if (ok) void privateMediaCachePolicy.cleanup();
      try {
        reply?.postMessage({ ok, generation });
      } catch {
        // The unchanged state remains authoritative if the tab left.
      }
      return;
    }
    stateVersion += 1;
    const enablesWrites = ok && nextEnabled;
    const nextState = {
      generation: nextGeneration,
      enabled: nextEnabled,
      cleanupActive: nextCleanupActive,
      version: stateVersion,
    };
    if (!enablesWrites) {
      generation = nextGeneration;
      enabled = nextEnabled;
      cleanupActive = nextCleanupActive;
      resumeGenerationOnEnable = false;
      publish();
    }
    try {
      await persist(nextState);
      if (enablesWrites) {
        if (context.epoch !== commandEpoch) {
          ok = false;
        } else {
          generation = nextGeneration;
          enabled = nextEnabled;
          cleanupActive = nextCleanupActive;
          resumeGenerationOnEnable = false;
          publish();
        }
      }
    } catch {
      generation = Math.max(generation, nextGeneration);
      enabled = false;
      cleanupActive = true;
      resumeGenerationOnEnable = false;
      publish();
      await clearPersistedState(nextState.version);
      ok = false;
    }
    if (ok) void privateMediaCachePolicy.cleanup();
    try {
      reply?.postMessage({ ok, generation });
    } catch {
      // The persisted fail-closed state remains authoritative if the tab left.
    }
  };

  let commandChain = stateReady;
  self.addEventListener("message", (event) => {
    if (event.data?.type !== messageType) return;
    const expiresAt = event.data.expiresAt;
    const expiredAtArrival =
      Number.isFinite(expiresAt) && Date.now() >= expiresAt;
    const context = {
      epoch: commandEpoch,
      expiredAtArrival,
      preappliedBegin: false,
    };
    if (event.data.command === "begin" && !expiredAtArrival) {
      commandEpoch += 1;
      context.epoch = commandEpoch;
      if (stateRestored) {
        applyBegin(context);
      } else {
        pendingBeginContexts.push(context);
      }
    }
    commandChain = commandChain.then(
      () => handleCommand(event, context),
      () => handleCommand(event, context),
    );
    event.waitUntil(commandChain);
  });
})();
