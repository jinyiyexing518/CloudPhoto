import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createChecks, runCli, runSmoke } from "./production-smoke.mjs";

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

test("passes the primary and Azure production contracts with timings", async () => {
  await withServer(
    (request, response) => {
      if (request.url === "/primary" || request.url === "/azure") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><title>Cloud Photo</title>");
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
        6
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
  let inFlight = 0;
  let maxInFlight = 0;
  await withServer(
    (request, response) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);

      setTimeout(() => {
        if (request.url === "/primary" || request.url === "/azure") {
          response.writeHead(200, { "content-type": "text/html" });
          response.end("<!doctype html><title>Cloud Photo</title>");
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
        inFlight -= 1;
      }, 20);
    },
    async (origin) => {
      const messages = logger();
      const exitCode = await runCli({
        env: testEnvironment(origin),
        logger: messages,
        attempts: 2,
        retryDelayMs: 0,
        requestTimeoutMs: 1_000,
      });

      assert.equal(exitCode, 1);
      assert.equal(invalidRequests, 2);
      assert.equal(maxInFlight, 6);
      assert.deepEqual(
        messages.output
          .filter(
            (message) =>
              message.startsWith("PASS ") || message.startsWith("FAIL ")
          )
          .slice(0, 6)
          .map((message) => message.split(":")[0]),
        [
          "PASS primary homepage",
          "PASS azure homepage",
          "PASS primary auth/me",
          "PASS azure auth/me",
          "PASS primary changelogs",
          "FAIL azure changelogs",
        ]
      );
      assert.ok(
        messages.output.some((message) =>
          message.includes("azure changelogs: response JSON is not an array")
        )
      );
    }
  );
});
