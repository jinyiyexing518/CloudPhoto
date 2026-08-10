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
    PRODUCTION_MANIFEST_URL: `${origin}/primary/manifest.webmanifest`,
    PRODUCTION_AZURE_HOME_URL: `${origin}/azure`,
    PRODUCTION_AZURE_MANIFEST_URL: `${origin}/azure/manifest.webmanifest`,
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
        name: "manifest",
        url: "https://primary.example/manifest.webmanifest",
      },
      {
        target: "azure",
        name: "manifest",
        url: "https://frontend.example/manifest.webmanifest",
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

test("rejects a manifest with an unsafe MIME type or incomplete metadata", async () => {
  const manifestCheck = createChecks({
    PRODUCTION_BASE_URL: "https://primary.example",
  }).find(({ target, name }) => target === "primary" && name === "manifest");
  assert(manifestCheck);

  await assert.rejects(
    manifestCheck.validate(new Response('{"name":"Cloud Photo"}', {
      headers: { "content-type": "application/octet-stream" },
    })),
    /response is not a web app manifest/,
  );
  await assert.rejects(
    manifestCheck.validate(new Response('{"name":"Cloud Photo"}', {
      headers: { "content-type": "application/manifest+json" },
    })),
    /required install metadata/,
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
    /does not identify a CloudPhoto entry route/,
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
        response.end('{"status":"ok","route":"cloudphoto-frontend"}');
      } else if (request.url?.endsWith("/manifest.webmanifest")) {
        response.writeHead(200, { "content-type": "application/manifest+json" });
        response.end('{"name":"Cloud Photo","start_url":"/","icons":[{"src":"/icon.svg","sizes":"192x192","type":"image/svg+xml"}]}');
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
        9
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
        response.end('{"status":"ok","route":"cloudphoto-frontend"}');
      } else if (request.url?.endsWith("/manifest.webmanifest")) {
        response.writeHead(200, { "content-type": "application/manifest+json" });
        response.end('{"name":"Cloud Photo","start_url":"/","icons":[{"src":"/icon.svg","sizes":"192x192","type":"image/svg+xml"}]}');
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
      return Response.json({ status: "ok", route: "cloudphoto-frontend" });
    }
    if (url.endsWith("/manifest.webmanifest")) {
      return new Response(
        '{"name":"Cloud Photo","start_url":"/","icons":[{"src":"/icon.svg","sizes":"192x192","type":"image/svg+xml"}]}',
        { headers: { "content-type": "application/manifest+json" } },
      );
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
  assert.equal(maxInFlight, 9);
  assert.equal(completed, 9);
  assert.deepEqual(
    messages.output
      .filter((message) => /^(PASS|FAIL) /.test(message))
      .map((message) => message.match(/^(?:PASS|FAIL) (\S+ \S+):/)[1]),
    [
      "primary homepage",
      "primary healthz",
      "azure homepage",
      "primary manifest",
      "azure manifest",
      "primary auth/me",
      "azure auth/me",
      "primary changelogs",
      "azure changelogs",
    ]
  );
  assert.match(messages.output[8], /^FAIL azure changelogs:/);
  assert.match(
    messages.output.at(-1),
    /Production smoke checks failed after 1 attempts:/
  );
});
