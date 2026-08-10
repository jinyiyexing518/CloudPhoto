import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import test from "node:test";
import { createChecks, runSmoke } from "./production-smoke.mjs";

const APPLE_TOUCH_ICON = readFileSync(
  new URL("../packages/client/public/apple-touch-icon.png", import.meta.url)
);
const WRONG_SIZE_ICON = readFileSync(
  new URL("../packages/client/public/pwa-192x192.png", import.meta.url)
);

const INSTALLABLE_MANIFEST = JSON.stringify({
  name: "Cloud Photo",
  short_name: "CloudPhoto",
  id: "/",
  lang: "zh-CN",
  start_url: "/",
  scope: "/",
  display: "standalone",
  theme_color: "#0078d4",
  background_color: "#f0f2f5",
  icons: [
    {
      src: "/pwa-192x192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/pwa-512x512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/maskable-icon.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ],
});
const SECURE_HOMEPAGE_HEADERS = {
  "content-type": "text/html",
  "content-security-policy": "frame-ancestors 'self'",
  "referrer-policy": "same-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
};
const INSTALLABLE_HOME_HTML = [
  "<!doctype html><title>Cloud Photo</title>",
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
].join("");

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
    PRODUCTION_MISSING_JS_URL: `${origin}/primary/assets/missing-deadbeef.js`,
    PRODUCTION_MISSING_CSS_URL: `${origin}/primary/assets/missing-deadbeef.css`,
    PRODUCTION_AZURE_MISSING_JS_URL: `${origin}/azure/assets/missing-deadbeef.js`,
    PRODUCTION_AZURE_MISSING_CSS_URL: `${origin}/azure/assets/missing-deadbeef.css`,
    PRODUCTION_APPLE_TOUCH_ICON_URL: `${origin}/primary/apple-touch-icon.png`,
    PRODUCTION_AZURE_APPLE_TOUCH_ICON_URL: `${origin}/azure/apple-touch-icon.png`,
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
        name: "missing-js-asset",
        url: "https://primary.example/assets/__cloudphoto_missing_asset__-deadbeef.js",
      },
      {
        target: "primary",
        name: "missing-css-asset",
        url: "https://primary.example/assets/__cloudphoto_missing_asset__-deadbeef.css",
      },
      {
        target: "azure",
        name: "missing-js-asset",
        url: "https://frontend.example/assets/__cloudphoto_missing_asset__-deadbeef.js",
      },
      {
        target: "azure",
        name: "missing-css-asset",
        url: "https://frontend.example/assets/__cloudphoto_missing_asset__-deadbeef.css",
      },
      {
        target: "primary",
        name: "apple-touch-icon",
        url: "https://primary.example/apple-touch-icon.png",
      },
      {
        target: "azure",
        name: "apple-touch-icon",
        url: "https://frontend.example/apple-touch-icon.png",
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

test("adds exact deployment marker checks when a deployed SHA is expected", () => {
  const sha = "a".repeat(40);
  const checks = createChecks({
    PRODUCTION_BASE_URL: "https://primary.example",
    PRODUCTION_AZURE_FRONTEND_URL: "https://frontend.example",
    PRODUCTION_DEPLOYED_SHA: sha,
  });

  assert.deepEqual(
    checks
      .filter(({ name }) => name === "deployment")
      .map(({ target, url }) => ({ target, url })),
    [
      {
        target: "primary",
        url: `https://primary.example/deployment.json?sha=${sha}`,
      },
      {
        target: "azure",
        url: `https://frontend.example/deployment.json?sha=${sha}`,
      },
    ]
  );
});

test("accepts only the exact no-store deployment marker SHA", async () => {
  const expectedSha = "a".repeat(40);
  const deploymentCheck = createChecks({
    PRODUCTION_BASE_URL: "https://primary.example",
    PRODUCTION_DEPLOYED_SHA: expectedSha,
  }).find(({ target, name }) => target === "primary" && name === "deployment");
  assert(deploymentCheck);

  const markerResponse = (sha, extra = {}) => new Response(
    JSON.stringify({ sha, ...extra }),
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
      },
    }
  );

  await assert.doesNotReject(deploymentCheck.validate(markerResponse(expectedSha)));
  await assert.rejects(
    deploymentCheck.validate(markerResponse("b".repeat(40))),
    /does not match expected SHA/
  );
  await assert.rejects(
    deploymentCheck.validate(markerResponse(expectedSha, { branch: "main" })),
    /does not match expected SHA/
  );
  await assert.rejects(
    deploymentCheck.validate(new Response(JSON.stringify({ sha: expectedSha }), {
      headers: { "content-type": "application/json" },
    })),
    /Cache-Control: no-store/
  );
});

test("rejects an invalid expected deployment SHA before issuing requests", () => {
  assert.throws(
    () => createChecks({ PRODUCTION_DEPLOYED_SHA: "7e2862c" }),
    /40-character commit SHA/
  );
});

test("deployment-only scope requires a SHA and runs only identity checks", () => {
  const sha = "a".repeat(40);
  const checks = createChecks({
    PRODUCTION_BASE_URL: "https://primary.example",
    PRODUCTION_AZURE_FRONTEND_URL: "https://frontend.example",
    PRODUCTION_DEPLOYED_SHA: sha,
    PRODUCTION_SMOKE_SCOPE: "deployment",
  });

  assert.deepEqual(
    checks.map(({ target, name }) => ({ target, name })),
    [
      { target: "primary", name: "deployment" },
      { target: "azure", name: "deployment" },
    ]
  );
  assert.throws(
    () => createChecks({ PRODUCTION_SMOKE_SCOPE: "deployment" }),
    /requires PRODUCTION_DEPLOYED_SHA/
  );
});

test("rejects a homepage without the anti-framing security baseline", async () => {
  const homepageCheck = createChecks({
    PRODUCTION_BASE_URL: "https://primary.example",
  }).find(({ target, name }) => target === "primary" && name === "homepage");
  assert(homepageCheck);

  for (const [header, expectedError] of [
    ["content-security-policy", /frame-ancestors/],
    ["referrer-policy", /Referrer-Policy/],
    ["x-content-type-options", /X-Content-Type-Options/],
    ["x-frame-options", /X-Frame-Options/],
  ]) {
    const headers = { ...SECURE_HOMEPAGE_HEADERS };
    delete headers[header];
    await assert.rejects(
      homepageCheck.validate(new Response(
        INSTALLABLE_HOME_HTML,
        { headers },
      )),
      expectedError,
    );
  }
});

test("requires canonical HSTS on direct and proxied frontend entries", async () => {
  const checks = createChecks({
    PRODUCTION_BASE_URL: "https://primary.example",
  });
  const primaryHomepage = checks.find(
    ({ target, name }) => target === "primary" && name === "homepage",
  );
  const azureHomepage = checks.find(
    ({ target, name }) => target === "azure" && name === "homepage",
  );
  assert(primaryHomepage);
  assert(azureHomepage);

  for (const value of [
    "",
    "max-age=10886400; includeSubDomains; preload",
    "max-age=31536000; includeSubDomains",
    "max-age=31536000; preload",
    "max-age=10886400; includeSubDomains; preload, max-age=31536000; includeSubDomains; preload",
  ]) {
    const headers = { ...SECURE_HOMEPAGE_HEADERS };
    if (value) {
      headers["strict-transport-security"] = value;
    } else {
      delete headers["strict-transport-security"];
    }
    await assert.rejects(
      primaryHomepage.validate(new Response(INSTALLABLE_HOME_HTML, { headers })),
      /Strict-Transport-Security/,
    );
  }

  await assert.doesNotReject(
    primaryHomepage.validate(new Response(INSTALLABLE_HOME_HTML, {
      headers: {
        ...SECURE_HOMEPAGE_HEADERS,
        "strict-transport-security": [
          "max-age=31536000; includeSubDomains; preload",
          "max-age=31536000; includeSubDomains",
        ].join(", "),
      },
    })),
  );
  await assert.rejects(
    primaryHomepage.validate(new Response(INSTALLABLE_HOME_HTML, {
      headers: {
        ...SECURE_HOMEPAGE_HEADERS,
        "strict-transport-security": [
          "max-age=31536000; includeSubDomains; preload",
          "max-age=0",
        ].join(", "),
      },
    })),
    /Strict-Transport-Security/,
  );
  await assert.rejects(
    azureHomepage.validate(new Response(INSTALLABLE_HOME_HTML, {
      headers: {
        ...SECURE_HOMEPAGE_HEADERS,
        "strict-transport-security": [
          "max-age=31536000; includeSubDomains; preload",
          "max-age=31536000; includeSubDomains; preload",
        ].join(", "),
      },
    })),
    /Strict-Transport-Security/,
  );
});

test("rejects a homepage without standard and Apple mobile capability metadata", async () => {
  const homepageCheck = createChecks({
    PRODUCTION_BASE_URL: "https://primary.example",
  }).find(({ target, name }) => target === "primary" && name === "homepage");
  assert(homepageCheck);

  await assert.rejects(
    homepageCheck.validate(new Response(
      INSTALLABLE_HOME_HTML.replace(
        '<meta name="mobile-web-app-capable" content="yes">',
        "",
      ),
      { headers: SECURE_HOMEPAGE_HEADERS },
    )),
    /mobile-web-app-capable/,
  );
  await assert.rejects(
    homepageCheck.validate(new Response(
      INSTALLABLE_HOME_HTML.replace(
        '<meta name="apple-mobile-web-app-capable" content="yes">',
        "",
      ),
      { headers: SECURE_HOMEPAGE_HEADERS },
    )),
    /apple-mobile-web-app-capable/,
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
  await assert.rejects(
    manifestCheck.validate(new Response(
      '{"name":"Cloud Photo","short_name":"CloudPhoto","id":"/","lang":"zh-CN","start_url":"/","scope":"/","display":"standalone","theme_color":"#0078d4","background_color":"#f0f2f5","icons":[{"src":"/icon.svg","sizes":"192x192","type":"image/svg+xml"},{"src":"/icon.svg","sizes":"512x512","type":"image/svg+xml"}]}',
      { headers: { "content-type": "application/manifest+json" } },
    )),
    /compatible PNG install icons/,
  );
  await assert.rejects(
    manifestCheck.validate(new Response(
      INSTALLABLE_MANIFEST.replace('"lang":"zh-CN"', '"lang":"en"'),
      { headers: { "content-type": "application/manifest+json" } },
    )),
    /stable root id and zh-CN language/,
  );
  const sourceLessManifest = JSON.parse(INSTALLABLE_MANIFEST);
  for (const icon of sourceLessManifest.icons) delete icon.src;
  sourceLessManifest.icons.unshift({
    src: "/favicon.svg",
    sizes: "any",
    type: "image/svg+xml",
    purpose: "any",
  });
  await assert.rejects(
    manifestCheck.validate(new Response(JSON.stringify(sourceLessManifest), {
      headers: { "content-type": "application/manifest+json" },
    })),
    /compatible PNG install icons/,
  );
  await assert.rejects(
    manifestCheck.validate(new Response(
      INSTALLABLE_MANIFEST.replaceAll('"src":"/', '"src":"//'),
      { headers: { "content-type": "application/manifest+json" } },
    )),
    /compatible PNG install icons/,
  );

  const appleTouchIconCheck = createChecks({
    PRODUCTION_BASE_URL: "https://primary.example",
  }).find(({ target, name }) => (
    target === "primary" && name === "apple-touch-icon"
  ));
  assert(appleTouchIconCheck);
  await assert.rejects(
    appleTouchIconCheck.validate(new Response(WRONG_SIZE_ICON, {
      headers: { "content-type": "image/png" },
    })),
    /expected 180x180, received 192x192/,
  );
  await assert.rejects(
    appleTouchIconCheck.validate(new Response(APPLE_TOUCH_ICON.subarray(0, 24), {
      headers: { "content-type": "image/png" },
    })),
    /not a valid PNG/,
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

test("rejects missing hashed assets that are successful or disguised as HTML", async () => {
  const missingAssetCheck = createChecks({
    PRODUCTION_BASE_URL: "https://primary.example",
  }).find(({ target, name }) => (
    target === "primary" && name === "missing-css-asset"
  ));
  assert(missingAssetCheck);

  await assert.rejects(
    missingAssetCheck.validate(new Response("<!doctype html><title>App</title>", {
      status: 404,
      headers: { "content-type": "text/html" },
    })),
    /unsafe MIME/,
  );
  await assert.rejects(
    missingAssetCheck.validate(Response.json({ error: "not_found" })),
    /expected 404/,
  );
  await assert.doesNotReject(
    missingAssetCheck.validate(Response.json(
      { error: "not_found" },
      { status: 404 },
    )),
  );
});

test("passes the primary and Azure production contracts with timings", async () => {
  await withServer(
    (request, response) => {
      if (request.url === "/primary" || request.url === "/azure") {
        response.writeHead(200, SECURE_HOMEPAGE_HEADERS);
        response.end(INSTALLABLE_HOME_HTML);
      } else if (request.url === "/primary/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"ok","route":"cloudphoto-frontend"}');
      } else if (request.url?.endsWith("/manifest.webmanifest")) {
        response.writeHead(200, { "content-type": "application/manifest+json" });
        response.end(INSTALLABLE_MANIFEST);
      } else if (request.url?.includes("/assets/missing-deadbeef.")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"error":"not_found"}');
      } else if (request.url?.endsWith("/apple-touch-icon.png")) {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(APPLE_TOUCH_ICON);
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
        15
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
        response.writeHead(200, SECURE_HOMEPAGE_HEADERS);
        response.end(INSTALLABLE_HOME_HTML);
      } else if (request.url === "/primary/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"ok","route":"cloudphoto-frontend"}');
      } else if (request.url?.endsWith("/manifest.webmanifest")) {
        response.writeHead(200, { "content-type": "application/manifest+json" });
        response.end(INSTALLABLE_MANIFEST);
      } else if (request.url?.includes("/assets/missing-deadbeef.")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"error":"not_found"}');
      } else if (request.url?.endsWith("/apple-touch-icon.png")) {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(APPLE_TOUCH_ICON);
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
        INSTALLABLE_MANIFEST,
        { headers: { "content-type": "application/manifest+json" } },
      );
    }
    if (url.includes("/assets/missing-deadbeef.")) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (url.endsWith("/apple-touch-icon.png")) {
      return new Response(APPLE_TOUCH_ICON, {
        headers: { "content-type": "image/png" },
      });
    }
    if (url.endsWith("/api/auth/me")) {
      return new Response('{"error":"Unauthorized"}', { status: 401 });
    }
    if (url.endsWith("/api/changelogs")) {
      return Response.json([]);
    }
    return new Response(INSTALLABLE_HOME_HTML, {
      headers: SECURE_HOMEPAGE_HEADERS,
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
  assert.equal(maxInFlight, 15);
  assert.equal(completed, 15);
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
      "primary missing-js-asset",
      "primary missing-css-asset",
      "azure missing-js-asset",
      "azure missing-css-asset",
      "primary apple-touch-icon",
      "azure apple-touch-icon",
      "primary auth/me",
      "azure auth/me",
      "primary changelogs",
      "azure changelogs",
    ]
  );
  assert.match(messages.output[14], /^FAIL azure changelogs:/);
  assert.match(
    messages.output.at(-1),
    /Production smoke checks failed after 1 attempts:/
  );
});
