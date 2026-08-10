import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function importTypeScript(relativeUrl, transform = (source) => source) {
  const source = transform(await readFile(new URL(relativeUrl, import.meta.url), "utf8"));
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

const playback = await importTypeScript("./videoPlaybackSession.ts", (source) =>
  source.replace(
    /import\s*\{[\s\S]*?\}\s*from\s*["']\.\/mediaRoute["'];?/,
    `const getPreferredMediaUrl = (url) => url.replace("blob.test", "proxy.test/media");
     const toDirectMediaUrl = (url) => url.replace("proxy.test/media", "blob.test");
     const toProxyMediaUrl = (url) => url.replace("blob.test", "proxy.test/media");`,
  ));

function session(id = 1) {
  return playback.createVideoPlaybackSession({
    photoName: "large.mp4",
    originalUrl: "https://blob.test/large.mp4?sig=secret",
    sessionId: id,
    needsThumbnailCapture: true,
  });
}

function scheduler() {
  let nextId = 0;
  const callbacks = new Map();
  return {
    set(callback) {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
    clear(id) {
      callbacks.delete(id);
    },
    flush() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach((callback) => callback());
    },
    get created() {
      return nextId;
    },
  };
}

function media(overrides = {}) {
  let playCalls = 0;
  let loadCalls = 0;
  return {
    currentSrc: "https://proxy.test/media/large.mp4?sig=secret",
    src: "https://proxy.test/media/large.mp4?sig=secret",
    currentTime: 18,
    duration: 61,
    paused: false,
    ended: false,
    seeking: false,
    readyState: 2,
    muted: true,
    volume: 0.35,
    playbackRate: 1.5,
    load() {
      loadCalls += 1;
    },
    play() {
      playCalls += 1;
      return Promise.resolve();
    },
    counts() {
      return { playCalls, loadCalls };
    },
    ...overrides,
  };
}

function harness(initial = session()) {
  let active = initial;
  let visible = true;
  const states = [];
  const clock = scheduler();
  const controller = playback.createVideoPlaybackController({
    getSession: () => active,
    setSession: (next) => {
      active = next;
    },
    onStatus: (status) => states.push(status),
    setTimer: (callback) => clock.set(callback),
    clearTimer: (id) => clock.clear(id),
    isVisible: () => visible,
  });
  controller.activate(active);
  return {
    controller,
    clock,
    get session() {
      return active;
    },
    states,
    setVisible(next) {
      visible = next;
    },
  };
}

test("a session that already played can fail over after a mid-stream stall", () => {
  const playable = playback.markVideoPlaybackPlayable(session());
  const fallback = playback.fallbackVideoPlaybackSession(
    playable,
    playable.source,
    {
      currentTime: 18,
      shouldResume: true,
      muted: true,
      volume: 0.35,
      playbackRate: 1.5,
    },
  );
  assert(fallback, "playable content must not disable recovery");
  assert.equal(fallback.source, "https://blob.test/large.mp4?sig=secret");
});

test("short waiting recovery and currentTime progress cancel the watchdog", () => {
  for (const recover of ["playing", "progress"]) {
    const run = harness();
    const video = media();
    run.controller.onPlay(run.session.key, video);
    run.controller.onWaiting(run.session.key, video);
    if (recover === "playing") {
      run.controller.onPlaying(run.session.key, video);
    } else {
      video.currentTime = 18.25;
      run.controller.onTimeUpdate(run.session.key, video);
    }
    run.clock.flush();
    assert.equal(run.session.fallbackAttempted, false, recover);
    assert.equal(video.counts().loadCalls, 0, recover);
  }
});

test("repeated waiting and stalled events keep the original watchdog deadline", () => {
  const run = harness();
  const video = media();
  run.controller.onPlay(run.session.key, video);
  run.controller.onWaiting(run.session.key, video);
  run.controller.onStalled(run.session.key, video);
  run.controller.onWaiting(run.session.key, video);
  assert.equal(run.clock.created, 1, "one interruption must use one bounded deadline");
  run.clock.flush();
  assert.equal(video.counts().loadCalls, 1);
});

test("pause, seek, ended, and hidden-document transitions never switch routes", () => {
  for (const cancel of ["pause", "seeking", "ended", "hidden"]) {
    let visible = true;
    let active = session();
    const clock = scheduler();
    const controller = playback.createVideoPlaybackController({
      getSession: () => active,
      setSession: (next) => {
        active = next;
      },
      onStatus: () => {},
      setTimer: (callback) => clock.set(callback),
      clearTimer: (id) => clock.clear(id),
      isVisible: () => visible,
    });
    controller.activate(active);
    const video = media();
    controller.onPlay(active.key, video);
    controller.onStalled(active.key, video);
    if (cancel === "pause") {
      video.paused = true;
      controller.onPause(active.key, video);
    } else if (cancel === "seeking") {
      video.seeking = true;
      controller.onSeeking(active.key, video);
    } else if (cancel === "ended") {
      video.ended = true;
      controller.onEnded(active.key, video);
    } else {
      visible = false;
      controller.onVisibilityChange();
    }
    clock.flush();
    assert.equal(active.fallbackAttempted, false, cancel);
  }
});

test("a visible stalled video rearms after backgrounding", () => {
  const run = harness();
  const video = media();
  run.controller.onPlay(run.session.key, video);
  run.controller.onWaiting(run.session.key, video);
  run.setVisible(false);
  run.controller.onVisibilityChange(video);
  run.clock.flush();
  assert.equal(video.counts().loadCalls, 0);

  run.setVisible(true);
  run.controller.onVisibilityChange(video);
  run.clock.flush();
  assert.equal(video.counts().loadCalls, 1);
});

test("stall failover restores 18s and playback properties exactly once", async () => {
  const run = harness();
  const video = media();
  run.controller.onPlay(run.session.key, video);
  run.controller.onStalled(run.session.key, video);
  run.clock.flush();
  assert.equal(run.session.fallbackAttempted, true);
  assert.equal(video.src, "https://blob.test/large.mp4?sig=secret");
  assert.deepEqual(video.counts(), { playCalls: 0, loadCalls: 1 });

  video.currentSrc = video.src;
  video.currentTime = 0;
  video.muted = false;
  video.volume = 1;
  video.playbackRate = 1;
  await run.controller.onLoadedMetadata(run.session.key, video);
  await run.controller.onLoadedMetadata(run.session.key, video);
  assert.equal(video.currentTime, 18);
  assert.equal(video.muted, true);
  assert.equal(video.volume, 0.35);
  assert.equal(video.playbackRate, 1.5);
  assert.equal(video.counts().playCalls, 1, "metadata duplicates must not double-play");
});

test("an after-play error switches once, then dual-route failure is explicit", () => {
  const run = harness(playback.markVideoPlaybackPlayable(session()));
  const video = media();
  run.controller.onPlay(run.session.key, video);
  assert.equal(run.controller.onError(run.session.key, video), true);
  assert.equal(
    run.controller.onError(run.session.key, video),
    false,
    "a duplicate error from the replaced source must be stale and harmless",
  );
  assert.equal(run.states.at(-1), "buffering");
  video.currentSrc = video.src;
  assert.equal(run.controller.onError(run.session.key, video), false);
  assert.equal(run.states.at(-1), "error");
  assert.equal(video.counts().loadCalls, 1, "each route has one attempt per session");
});

test("retry creates a fresh route budget and keeps the last position", () => {
  const run = harness();
  const video = media();
  run.controller.onPlay(run.session.key, video);
  run.controller.onError(run.session.key, video);
  video.currentTime = 0;
  video.currentSrc = video.src;
  run.controller.onError(run.session.key, video);
  const failedKey = run.session.key;
  const retried = run.controller.retry(2, video);
  assert.notEqual(retried.key, failedKey);
  assert.equal(retried.fallbackAttempted, false);
  assert.equal(retried.restore?.currentTime, 18);
  assert.deepEqual(retried.attemptedSources, [retried.source]);
});

test("stale photo timers and events cannot mutate a newer viewer", () => {
  const run = harness(session(1));
  const stale = run.session;
  const staleVideo = media();
  run.controller.onPlay(stale.key, staleVideo);
  run.controller.onWaiting(stale.key, staleVideo);
  const fresh = session(2);
  run.controller.activate(fresh);
  run.clock.flush();
  assert.equal(run.session.key, fresh.key);
  assert.equal(run.controller.onError(stale.key, staleVideo), false);
  assert.equal(run.session.key, fresh.key);
});

test("stale play rejection and visibility changes preserve newer or terminal state", async () => {
  const run = harness();
  let rejectPlay;
  const video = media({
    play: () => new Promise((_resolve, reject) => {
      rejectPlay = reject;
    }),
  });
  run.controller.onPlay(run.session.key, video);
  run.controller.onError(run.session.key, video);
  video.currentSrc = video.src;
  const restorePromise = run.controller.onLoadedMetadata(run.session.key, video);
  const fresh = {
    ...session(2),
    restore: {
      currentTime: 18,
      shouldResume: true,
      muted: true,
      volume: 0.35,
      playbackRate: 1.5,
    },
  };
  run.controller.activate(fresh);
  rejectPlay(new Error("old element autoplay rejection"));
  await restorePromise;
  assert.equal(run.session.key, fresh.key);
  assert.equal(run.states.at(-1), "buffering");

  const failedVideo = media();
  run.controller.onError(fresh.key, failedVideo);
  failedVideo.currentSrc = failedVideo.src;
  run.controller.onError(fresh.key, failedVideo);
  assert.equal(run.states.at(-1), "error");
  run.setVisible(false);
  run.controller.onVisibilityChange();
  assert.equal(run.states.at(-1), "error", "backgrounding must retain retry UI");
  run.controller.onCanPlay(fresh.key, failedVideo);
  assert.equal(run.controller.onLoadedData(fresh.key, failedVideo), false);
  run.controller.onPlaying(fresh.key, failedVideo);
  assert.equal(run.states.at(-1), "error", "late media events must retain retry UI");
});

test("stale source metadata cannot consume the active route restore", async () => {
  const run = harness();
  const video = media();
  run.controller.onPlay(run.session.key, video);
  const oldSource = video.currentSrc;
  run.controller.onError(run.session.key, video);
  video.currentTime = 0;
  assert.equal(run.controller.onLoadedData(run.session.key, video), false);
  await run.controller.onLoadedMetadata(run.session.key, video);
  assert.equal(video.currentTime, 0, "metadata from the replaced source must be ignored");

  video.currentSrc = video.src;
  await run.controller.onLoadedMetadata(run.session.key, video);
  assert.notEqual(video.currentSrc, oldSource);
  assert.equal(video.currentTime, 18);
});

test("timeline and folder viewers both use the shared resilient hook", async () => {
  for (const relative of [
    "../components/gallery/PhotoGallery.tsx",
    "../components/gallery/FolderView.tsx",
  ]) {
    const source = await readFile(new URL(relative, import.meta.url), "utf8");
    assert.match(source, /useResilientVideoPlayback/);
    assert.doesNotMatch(source, /fallbackVideoPlaybackSession/);
    assert.doesNotMatch(source, /setTimeout\([^)]*video/i);
    assert.match(source, /useModalFocusBoundary/);
    assert.match(source, /createPortal/);
    assert.match(source, /aria-modal="true"/);
  }
});

test("video route probe accepts only 206 and cancels every response body", async () => {
  const mediaRoute = await importTypeScript("./mediaRoute.ts", (source) =>
    source.replaceAll("import.meta.env", "({})"));
  for (const [status, expected] of [[200, false], [206, true]]) {
    let canceled = 0;
    const fetchImpl = async (_url, init) => {
      assert.equal(init.method, "GET");
      assert.equal(new Headers(init.headers).get("Range"), "bytes=0-1");
      return {
        status,
        ok: true,
        headers: new Headers({ "content-type": "video/mp4" }),
        body: {
          async cancel() {
            canceled += 1;
          },
        },
      };
    };
    assert.equal(
      await mediaRoute.probeVideoMediaUrl("https://blob.test/large.mp4?sig=secret", new AbortController().signal, fetchImpl),
      expected,
    );
    assert.equal(canceled, 1);
  }
});

test("video route selection prefers the only route that proves Range support", async () => {
  const mediaRoute = await importTypeScript("./mediaRoute.ts", (source) =>
    source.replaceAll("import.meta.env", "({})"));
  const originalFetch = globalThis.fetch;
  const canceled = [];
  globalThis.fetch = async (url, init) => ({
    status: String(url).includes("cloudphotos.top/media") ? 206 : 200,
    ok: true,
    headers: new Headers({ "content-type": "video/mp4" }),
    body: {
      async cancel() {
        canceled.push(String(url));
      },
    },
  });
  try {
    assert.equal(
      await mediaRoute.selectFastestVideoMediaRoute(
        "https://photostorage.blob.core.windows.net/photos/large.mp4?sig=secret",
      ),
      "proxy",
    );
    assert.equal(canceled.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
