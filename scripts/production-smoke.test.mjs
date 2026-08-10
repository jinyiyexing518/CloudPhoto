import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createChecks, runSmoke } from "./production-smoke.mjs";

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

function testEnvironment(origin) {
  return {
    PRODUCTION_HOME_URL: `${origin}/primary`,
    PRODUCTION_HEALTH_URL: `${origin}/primary/healthz`,
    PRODUCTION_AZURE_HOME_URL: `${origin}/azure`,
    PRODUCTION_AUTH_ME_URL: `${origin}/primary/api/auth/me`,
    PRODUCTION_AZURE_AUTH_ME_URL: `${origin}/azure/api/auth/me`,
    PRODUCTION_CHANGELOGS_URL: `${origin}/primary/api/changelogs`,
    PRODUCTION_AZURE_CHANGELOGS_URL: `${origin}/azure/api/changelogs`,
  };
}

function logger() {
  const output = [];
  return {
    output,
    log: (message) => output.push(message),
    error: (message) => output.push(message),
  };
}

test("builds primary and Azure checks from base URL overrides", () => {
  const checks = createChecks({
    PRODUCTION_BASE_URL: "https://primary.example",
    PRODUCTION_AZURE_FRONTEND_URL: "https://frontend.example",
    PRODUCTION_AZURE_API_BASE_URL: "https://api.example/api",
  });

  assert.deepEqual(
    checks.map(({ target, name, url }) => ({ target, name, url })),
    [
      {
        target: "primary",
        name: "homepage",
        url: "https://primary.example/",
      },
      {
        target: "primary",
        name: "healthz",
        url: "https://primary.example/healthz",
      },
      {
        target: "azure",
        name: "homepage",
        url: "https://frontend.example/",
      },
      {
        target: "primary",
        name: "auth/me",
        url: "https://primary.example/api/auth/me",
      },
      {
        target: "azure",
        name: "auth/me",
        url: "https://api.example/api/auth/me",
      },
      {
        target: "primary",
        name: "changelogs",
        url: "https://primary.example/api/changelogs",
      },
      {
        target: "azure",
        name: "changelogs",
        url: "https://api.example/api/changelogs",
      },
    ]
  );
});

test("rejects a proxy health route that falls through to the SPA", async () => {
  const healthCheck = createChecks({
    PRODUCTION_BASE_URL: "https://primary.example",
  }).find(({ name }) => name === "healthz");
  assert(healthCheck);

  await assert.rejects(
    healthCheck.validate(new Response("<!doctype html>", {
      headers: { "content-type": "text/html" },
    })),
    /response is not JSON/,
  );
  await assert.rejects(
    healthCheck.validate(Response.json({ status: "ok", route: "wrong-route" })),
    /does not identify the CloudPhoto proxy/,
  );
});

test("passes the primary and Azure production contracts with timings", async () => {
  await withServer(
    (request, response) => {
      if (request.url === "/primary" || request.url === "/azure") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><title>Cloud Photo</title>");
      } else if (request.url === "/primary/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"ok","route":"cloudphoto-proxy"}');
      } else if (request.url?.endsWith("/api/auth/me")) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end('{"error":"Unauthorized"}');
      } else if (request.url?.endsWith("/api/changelogs")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("[]");
      } else {
        response.writeHead(404);
        response.end();
      }
    },
    async (origin) => {
      const messages = logger();
      const passed = await runSmoke({
        env: testEnvironment(origin),
        logger: messages,
        attempts: 1,
        requestTimeoutMs: 1_000,
      });

      assert.equal(passed, true);
      assert.equal(
        messages.output.filter((message) => message.startsWith("PASS ")).length,
        7
      );
      assert.ok(
        messages.output.some((message) =>
          /^PASS primary homepage: .+ \(\d+ms\)$/.test(message)
        )
      );
      assert.ok(
        messages.output.some((message) =>
          /^PASS azure changelogs: .+ \(\d+ms\)$/.test(message)
        )
      );
    }
  );
});

test("retries and fails when either changelog response is not an array", async () => {
  let invalidRequests = 0;
  await withServer(
    (request, response) => {
      if (request.url === "/primary" || request.url === "/azure") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><title>Cloud Photo</title>");
      } else if (request.url === "/primary/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"ok","route":"cloudphoto-proxy"}');
      } else if (request.url?.endsWith("/api/auth/me")) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end('{"error":"Unauthorized"}');
      } else if (request.url === "/azure/api/changelogs") {
        invalidRequests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      } else if (request.url?.endsWith("/api/changelogs")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("[]");
      } else {
        response.writeHead(404);
        response.end();
      }
    },
    async (origin) => {
      const messages = logger();
      const passed = await runSmoke({
        env: testEnvironment(origin),
        logger: messages,
        attempts: 2,
        retryDelayMs: 0,
        requestTimeoutMs: 1_000,
      });

      assert.equal(passed, false);
      assert.equal(invalidRequests, 2);
      assert.ok(
        messages.output.some((message) =>
          message.includes("azure changelogs: response JSON is not an array")
        )
      );
    }
  );
});

test("runs all checks concurrently and reports an isolated failure in order", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let completed = 0;

  const fetchImpl = async (url) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight -= 1;
    completed += 1;

    if (url.endsWith("/azure/api/changelogs")) {
      throw new Error("controlled failure");
    }
    if (url.endsWith("/healthz")) {
      return Response.json({ status: "ok", route: "cloudphoto-proxy" });
    }
    if (url.endsWith("/api/auth/me")) {
      return new Response('{"error":"Unauthorized"}', { status: 401 });
    }
    if (url.endsWith("/api/changelogs")) {
      return Response.json([]);
    }
    return new Response("<!doctype html><title>Cloud Photo</title>", {
      headers: { "content-type": "text/html" },
    });
  };

  const messages = logger();
  const passed = await runSmoke({
    env: testEnvironment("https://example.test"),
    fetchImpl,
    logger: messages,
    attempts: 1,
    requestTimeoutMs: 1_000,
  });

  assert.equal(passed, false);
  assert.equal(maxInFlight, 7);
  assert.equal(completed, 7);
  assert.deepEqual(
    messages.output
      .filter((message) => /^(PASS|FAIL) /.test(message))
      .map((message) => message.match(/^(?:PASS|FAIL) (\S+ \S+):/)[1]),
    [
      "primary homepage",
      "primary healthz",
      "azure homepage",
      "primary auth/me",
      "azure auth/me",
      "primary changelogs",
      "azure changelogs",
    ]
  );
  assert.match(messages.output[6], /^FAIL azure changelogs:/);
  assert.match(
    messages.output.at(-1),
    /Production smoke checks failed after 1 attempts:/
  );
});
