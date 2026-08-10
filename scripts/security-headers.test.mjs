import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const CANONICAL_HSTS = "max-age=31536000; includeSubDomains; preload";
const root = new URL("../", import.meta.url);

test("SWA explicitly overrides the platform HSTS default", () => {
  const config = JSON.parse(readFileSync(
    new URL("packages/client/public/staticwebapp.config.json", root),
    "utf8",
  ));

  assert.equal(
    config.globalHeaders?.["Strict-Transport-Security"],
    CANONICAL_HSTS,
  );
});

test("Nginx emits one canonical security-header set for frontend responses", () => {
  const source = readFileSync(new URL("infra/nginx.conf", root), "utf8");
  const frontendLocation = source.match(
    /# ── \/ → Azure Static Web App[\s\S]*?location \/ \{(?<body>[\s\S]*?)^\s{4}\}/m,
  )?.groups?.body;
  assert(frontendLocation, "missing frontend proxy location");

  for (const header of [
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options",
  ]) {
    assert.match(
      frontendLocation,
      new RegExp(`proxy_hide_header\\s+${header};`),
      `frontend proxy must hide upstream ${header}`,
    );
  }
  const hstsValues = [
    ...source.matchAll(/add_header Strict-Transport-Security "([^"]+)" always;/g),
  ].map((match) => match[1]);
  assert(hstsValues.length > 0, "Nginx must emit HSTS");
  assert.deepEqual([...new Set(hstsValues)], [CANONICAL_HSTS]);
});
