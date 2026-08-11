import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function compileTypeScript(relativeUrl, transform = (source) => source) {
  const source = transform(await readFile(relativeUrl, "utf8"));
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativeUrl.pathname,
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
}

const authScopeUrl = await compileTypeScript(new URL("./authScope.ts", import.meta.url));
const routingPolicyUrl = await compileTypeScript(new URL("./apiRoutingPolicy.ts", import.meta.url));
const apiBaseUrl = await compileTypeScript(
  new URL("../utils/apiBase.ts", import.meta.url),
  (source) => source
    .replace(/import\.meta\.env\.VITE_API_BASE as string \| undefined/g, "undefined")
    .replace(/import\.meta\.env\.VITE_PROXY_API_BASE as string \| undefined/g, "undefined"),
);

globalThis.window = {
  location: {
    hostname: "cloudphotos.top",
    origin: "https://cloudphotos.top",
  },
};
const stored = new Map();
globalThis.localStorage = {
  getItem: (key) => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: (key) => stored.delete(key),
};

const httpUrl = await compileTypeScript(
  new URL("./http.ts", import.meta.url),
  (source) => source
    .replace('"../utils/apiBase"', JSON.stringify(apiBaseUrl))
    .replace('"./authScope"', JSON.stringify(authScopeUrl))
    .replace('"./apiRoutingPolicy"', JSON.stringify(routingPolicyUrl)),
);
const { fetchWithTimeout } = await import(httpUrl);
const { shouldHedgeApiRequest } = await import(routingPolicyUrl);
const authApiUrl = await compileTypeScript(
  new URL("./authApi.ts", import.meta.url),
  (source) => source
    .replace('"../utils/apiBase"', JSON.stringify(apiBaseUrl))
    .replace('"./http"', JSON.stringify(httpUrl)),
);
const { loginApi } = await import(authApiUrl);

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

test("login waits for same-origin failure before retrying serially on Azure", async (t) => {
  const calls = [];
  let rejectPrimary;
  globalThis.fetch = (input) => {
    const url = String(input);
    calls.push(url);
    if (url === "/api/auth/login") {
      return new Promise((_resolve, reject) => {
        rejectPrimary = reject;
      });
    }
    return Promise.resolve(new Response(JSON.stringify({ route: "direct" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  };
  t.after(() => { delete globalThis.fetch; });

  const pending = fetchWithTimeout("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "user", password: "secret" }),
  }, 1_000);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(calls, ["/api/auth/login"]);
  assert.equal(shouldHedgeApiRequest("POST", "/auth/login"), false);
  rejectPrimary(new TypeError("same-origin transport failed"));

  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "/api/auth/login",
    "https://cloudphoto-api.azurewebsites.net/api/auth/login",
  ]);
});

test("a hung same-origin login gets a bounded serial direct attempt within the caller budget", async (t) => {
  const calls = [];
  globalThis.fetch = (input) => {
    const url = String(input);
    calls.push(url);
    if (url === "/api/auth/login") return new Promise(() => {});
    return Promise.resolve(new Response(JSON.stringify({ route: "direct" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  };
  t.after(() => { delete globalThis.fetch; });

  const startedAt = performance.now();
  const response = await fetchWithTimeout("/api/auth/login", {
    method: "POST",
    body: "{}",
  }, 6_000);

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "/api/auth/login",
    "https://cloudphoto-api.azurewebsites.net/api/auth/login",
  ]);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs >= 4_500, `primary deadline fired too early: ${elapsedMs}ms`);
  assert.ok(elapsedMs < 5_900, `fallback exhausted the caller budget: ${elapsedMs}ms`);
  assert.deepEqual(await response.json(), { route: "direct" });
});

test("caller abort cancels a hung login without alternate-route fallback", async (t) => {
  const calls = [];
  globalThis.fetch = (input, init) => {
    calls.push(String(input));
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        reject(init.signal.reason ?? new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  };
  t.after(() => { delete globalThis.fetch; });
  const controller = new AbortController();
  const pending = fetchWithTimeout("/api/auth/login", {
    method: "POST",
    body: "{}",
    signal: controller.signal,
  }, 6_000);
  setTimeout(() => controller.abort(new DOMException("Caller cancelled", "AbortError")), 20);

  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(calls, ["/api/auth/login"]);
});

test("a Request login body is never replayed through a bodyless alternate request", async (t) => {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      body: input instanceof Request ? await input.clone().text() : init?.body,
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      url: input instanceof Request ? input.url : String(input),
    });
    return new Response(JSON.stringify({ error: "gateway" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => { delete globalThis.fetch; });

  const response = await fetchWithTimeout(new Request(
    "https://cloudphotos.top/api/auth/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "user", password: "secret" }),
    },
  ), undefined, 1_000);

  assert.equal(response.status, 503);
  assert.deepEqual(calls, [{
    body: JSON.stringify({ username: "user", password: "secret" }),
    method: "POST",
    url: "https://cloudphotos.top/api/auth/login",
  }]);
  await response.body?.cancel();
});

test("aborted direct fallback cancels the retained primary gateway body", async (t) => {
  const calls = [];
  let primaryBodyCancellations = 0;
  globalThis.fetch = (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url === "/api/auth/login") {
      return Promise.resolve(new Response(new ReadableStream({
        cancel() {
          primaryBodyCancellations += 1;
        },
      }), { status: 503 }));
    }
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        reject(init.signal.reason ?? new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  };
  t.after(() => { delete globalThis.fetch; });

  await assert.rejects(
    fetchWithTimeout("/api/auth/login", { method: "POST", body: "{}" }, 100),
    { name: "AbortError" },
  );
  assert.deepEqual(calls, [
    "/api/auth/login",
    "https://cloudphoto-api.azurewebsites.net/api/auth/login",
  ]);
  assert.equal(primaryBodyCancellations, 1);
});

test("non-settling primary body cancellation cannot delay caller timeout", async (t) => {
  let primaryBodyCancellations = 0;
  globalThis.fetch = (input, init) => {
    if (String(input) === "/api/auth/login") {
      return Promise.resolve(new Response(new ReadableStream({
        cancel() {
          primaryBodyCancellations += 1;
          return new Promise(() => {});
        },
      }), { status: 503 }));
    }
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        reject(init.signal.reason ?? new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  };
  t.after(() => { delete globalThis.fetch; });

  const timedRequest = assert.rejects(
    fetchWithTimeout("/api/auth/login", { method: "POST", body: "{}" }, 50),
    { name: "AbortError" },
  );
  let guardTimeout;
  try {
    await Promise.race([
      timedRequest,
      new Promise((_, reject) => {
        guardTimeout = setTimeout(
          () => reject(new Error("request remained pending after caller timeout")),
          250,
        );
      }),
    ]);
  } finally {
    clearTimeout(guardTimeout);
  }
  assert.equal(primaryBodyCancellations, 1);
});

test("non-settling primary body cancellation cannot delay successful fallback", async (t) => {
  let primaryBodyCancellations = 0;
  globalThis.fetch = (input) => {
    if (String(input) === "/api/auth/login") {
      return Promise.resolve(new Response(new ReadableStream({
        cancel() {
          primaryBodyCancellations += 1;
          return new Promise(() => {});
        },
      }), { status: 503 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ route: "direct" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  };
  t.after(() => { delete globalThis.fetch; });

  const fallbackRequest = fetchWithTimeout(
    "/api/auth/login",
    { method: "POST", body: "{}" },
    1_000,
  );
  let guardTimeout;
  let response;
  try {
    response = await Promise.race([
      fallbackRequest,
      new Promise((_, reject) => {
        guardTimeout = setTimeout(
          () => reject(new Error("successful fallback waited for primary body cancellation")),
          250,
        );
      }),
    ]);
  } finally {
    clearTimeout(guardTimeout);
  }
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { route: "direct" });
  assert.equal(primaryBodyCancellations, 1);
});

test("retryable login gateway responses fall back but unsafe writes never replay", async (t) => {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("/api/")) {
      if (url.endsWith("/auth/login")) return new Response(null, { status: 503 });
      throw new TypeError("same-origin transport failed");
    }
    return new Response(JSON.stringify({ route: "direct" }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => { delete globalThis.fetch; });

  const loginResponse = await fetchWithTimeout("/api/auth/login", {
    method: "POST",
    body: "{}",
  }, 1_000);
  assert.equal(loginResponse.status, 202);
  assert.deepEqual(calls.splice(0), [
    "/api/auth/login",
    "https://cloudphoto-api.azurewebsites.net/api/auth/login",
  ]);

  for (const path of [
    "/api/auth/register",
    "/api/photos/upload",
    "/api/photos/share",
    "/api/groups",
  ]) {
    await assert.rejects(
      fetchWithTimeout(path, { method: "POST", body: "{}" }, 1_000),
      /same-origin transport failed/,
    );
    assert.deepEqual(calls.splice(0), [path]);
  }

  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ error: "account not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  };
  const rejectedLogin = await fetchWithTimeout("/api/auth/login", {
    method: "POST",
    body: "{}",
  }, 1_000);
  assert.equal(rejectedLogin.status, 404);
  assert.deepEqual(calls.splice(0), ["/api/auth/login"]);

  const rejectedShareLookup = await fetchWithTimeout("/api/photos/share", {
    method: "GET",
  }, 1_000);
  assert.equal(rejectedShareLookup.status, 404);
  assert.deepEqual(calls.splice(0), ["/api/photos/share"]);

  const oldToken = jwt({ userId: "user", role: "viewer" });
  const newToken = jwt({ userId: "user", role: "viewer" });
  localStorage.setItem("cloudphoto_token", oldToken);
  localStorage.setItem("cloudphoto_refresh_token", "refresh-old");
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/auth/refresh")) {
      return new Response(JSON.stringify({
        token: newToken,
        refreshToken: "refresh-new",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "invalid credentials" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  };
  const unauthorizedLogin = await fetchWithTimeout("/api/auth/login", {
    method: "POST",
    body: "{}",
  }, 1_000);
  assert.equal(unauthorizedLogin.status, 401);
  assert.deepEqual(calls.splice(0), ["/api/auth/login"]);
  localStorage.removeItem("cloudphoto_token");
  localStorage.removeItem("cloudphoto_refresh_token");
});

test("only the exact read-only location recovery POST gains serial route replay", async (t) => {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("/api/")) {
      throw new TypeError("same-origin transport failed");
    }
    return new Response(JSON.stringify({
      locations: [],
      processed: [],
      bytesRead: 0,
      truncated: false,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => { delete globalThis.fetch; });

  const response = await fetchWithTimeout("/api/photos/locations/recover", {
    method: "POST",
    body: JSON.stringify({ photos: [] }),
  }, 1_000);
  assert.equal(response.status, 200);
  assert.deepEqual(calls.splice(0), [
    "/api/photos/locations/recover",
    "https://cloudphoto-api.azurewebsites.net/api/photos/locations/recover",
  ]);
  assert.equal(shouldHedgeApiRequest("POST", "/photos/locations/recover"), false);

  await assert.rejects(
    fetchWithTimeout("/api/photos/locations", {
      method: "POST",
      body: "{}",
    }, 1_000),
    /same-origin transport failed/,
  );
  assert.deepEqual(calls, ["/api/photos/locations"]);
});

test("login errors describe exhausted transport and gateway routes instead of only the proxy", async (t) => {
  const calls = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ error: "upstream unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => { delete globalThis.fetch; });

  const startedAt = performance.now();
  await assert.rejects(
    loginApi("user", "secret"),
    /登录服务暂时不可用，请稍后重试/,
  );
  assert.ok(performance.now() - startedAt < 1_000);
  assert.deepEqual(calls, [
    "/api/auth/login",
    "https://cloudphoto-api.azurewebsites.net/api/auth/login",
  ]);

  const source = await readFile(new URL("./authApi.ts", import.meta.url), "utf8");
  assert.match(source, /登录服务暂时不可用，请稍后重试/);
  assert.match(source, /登录响应超时，服务器可能正在启动，请稍后重试/);
  assert.doesNotMatch(source, /代理服务器不可用/);
});
