import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (relativePath) =>
  readFileSync(join(repoRoot, relativePath), "utf8");

const styles = read("packages/client/src/authenticated.css");
const filterBar = read("packages/client/src/components/gallery/FilterBar.tsx");
const photoTimeDialog = read(
  "packages/client/src/components/shared/PhotoTimeEditDialog.tsx",
);
const timeCapsule = read(
  "packages/client/src/components/time-capsule/TimeCapsule.tsx",
);
const photoGallery = read(
  "packages/client/src/components/gallery/PhotoGallery.tsx",
);
const photoCard = read("packages/client/src/components/gallery/PhotoCard.tsx");
const folderView = read(
  "packages/client/src/components/gallery/FolderView.tsx",
);
const dateHelperPath = join(
  repoRoot,
  "packages/client/src/utils/dateFormat.ts",
);

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert(match, `missing CSS block for ${selector}`);
  return match[1];
}

function declaration(block, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`${escaped}\\s*:\\s*([^;]+)`));
  assert(match, `missing ${property} declaration`);
  return match[1].trim();
}

function sourceFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  });
}

test("authenticated native controls share one typography scope", () => {
  const nativeControls = cssBlock(
    ".auth-native-control-scope :where(input, select, button)",
  );
  assert.equal(declaration(nativeControls, "font-family"), "inherit");
  assert.equal(declaration(nativeControls, "font-size"), "0.85rem");
  assert.equal(declaration(nativeControls, "line-height"), "1.25");
  assert.equal(declaration(nativeControls, "font-weight"), "400");
  assert.equal(declaration(nativeControls, "color"), "#374151");
  assert.equal(declaration(nativeControls, "min-height"), "44px");

  const numericControls = cssBlock(
    '.auth-native-control-scope :where(input[type="date"], input[type="time"])',
  );
  assert.equal(
    declaration(numericControls, "font-variant-numeric"),
    "tabular-nums",
  );

  for (const [name, source] of [
    ["FilterBar", filterBar],
    ["PhotoTimeEditDialog", photoTimeDialog],
    ["TimeCapsule", timeCapsule],
  ]) {
    assert.match(
      source,
      /auth-native-control-scope/,
      `${name} must opt into the shared native-control scope`,
    );
  }

  assert.doesNotMatch(
    styles,
    /auth-native-control-scope[^}]*calendar-picker-indicator[^}]*?(?:display\s*:\s*none|opacity\s*:\s*0|visibility\s*:\s*hidden)/s,
  );

  assert.equal(
    declaration(cssBlock(".time-edit-dialog .confirm-cancel-btn"), "font-size"),
    "0.85rem",
  );
  assert.equal(
    declaration(cssBlock(".time-edit-save-btn"), "font-weight"),
    "400",
  );
  assert.equal(declaration(cssBlock(".time-edit-chip"), "font-size"), "0.85rem");
  const capsuleClose = cssBlock(".capsule-dialog .dialog-close-btn");
  assert.equal(declaration(capsuleClose, "font-size"), "1rem");
  assert.equal(declaration(capsuleClose, "color"), "#9ca3af");
});

test("one zh-CN helper is stable under an English default locale and handles invalid input", () => {
  assert(existsSync(dateHelperPath), "missing shared zh-CN date helper");

  const helperUrl = pathToFileURL(dateHelperPath).href;
  const script = `
    const OriginalDateTimeFormat = Intl.DateTimeFormat;
    const originalToLocaleString = Date.prototype.toLocaleString;
    const locales = [];
    Intl.DateTimeFormat = class extends OriginalDateTimeFormat {
      constructor(locale, options) {
        super(locale ?? "en-US", options);
      }
    };
    Date.prototype.toLocaleString = function(locale, options) {
      locales.push(locale);
      return originalToLocaleString.call(this, locale, options);
    };
    const {
      formatPhotoDate,
      formatPhotoDateTime,
      formatPhotoDateTimeSeconds,
      formatPhotoLongDate,
      formatPhotoMonthDay,
    } = await import(${JSON.stringify(helperUrl + "?locale-contract")});
    const sample = new Date(2026, 7, 10, 12, 34, 0);
    console.log(JSON.stringify({
      defaultLocale: new Intl.DateTimeFormat().resolvedOptions().locale,
      longDate: formatPhotoLongDate(sample),
      shortDate: formatPhotoDate(sample),
      dateTime: formatPhotoDateTime(sample),
      dateTimeSeconds: formatPhotoDateTimeSeconds(sample),
      dateOnly: formatPhotoMonthDay("2026-08-10"),
      invalid: formatPhotoDateTime("not-a-date"),
      locales,
    }));
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        TZ: "America/Los_Angeles",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.match(output.defaultLocale, /^en(?:-|$)/i);
  assert.match(output.longDate, /2026年8月10日/);
  assert.match(output.shortDate, /2026年8月10日/);
  assert.match(output.dateTime, /2026年8月10日/);
  assert.match(output.dateTimeSeconds, /2026(?:年|\/)8(?:月|\/)10/);
  assert.equal(output.dateOnly, "8月10日");
  assert.doesNotMatch(
    `${output.longDate} ${output.shortDate} ${output.dateTime}`,
    /August|Aug|June|Jun/i,
  );
  assert.equal(output.invalid, "");
  assert.match(read("packages/client/src/utils/dateFormat.ts"), /PHOTO_LOCALE = "zh-CN"/);
  assert(output.locales.length > 0);
  assert(output.locales.every((locale) => locale === "zh-CN"));
});

test("timeline, cards, and folder viewer share formatter presets", () => {
  assert.match(
    photoGallery,
    /formatPhotoGroupDate\(key\) \|\| "日期未知"/,
    "timeline headings must keep the timezone-noon guard",
  );
  assert.match(
    photoGallery,
    /getPhotoDateKey\(raw \?\? ""\) \|\| "0000-00-00"/,
    "invalid timeline timestamps must use the explicit unknown-date bucket",
  );
  assert.match(
    photoGallery,
    /formatPhotoDateTime\(value\)/,
    "timeline viewer must use the shared date-time preset",
  );
  assert.match(
    folderView,
    /formatPhotoDateTime\(value\)/,
    "folder viewer must use the same date-time preset",
  );
  assert.match(
    photoCard,
    /formatPhotoDate\(photo\.createdAt\)/,
  );
  assert.match(
    photoCard,
    /formatPhotoDate\(photo\.takenAt\)/,
  );

  const authenticatedSources = sourceFiles(
    join(repoRoot, "packages/client/src"),
  ).map((path) => [path, readFileSync(path, "utf8")]);
  const undefinedLocaleCalls = authenticatedSources.filter(([, source]) =>
    /new Date\([^)]*\)\.toLocale(?:DateString|TimeString|String)\(\s*(?:undefined\s*[,)]|\))/m.test(
      source,
    ),
  );
  assert.deepEqual(
    undefinedLocaleCalls.map(([path]) => path),
    [],
    "authenticated date displays must not depend on the browser default locale",
  );
  assert.deepEqual(
    authenticatedSources
      .filter(([, source]) => /dateDisplay|formatZhCnDate/.test(source))
      .map(([path]) => path),
    [],
    "authenticated date displays must reuse the sole dateFormat helper",
  );
});

test("native date inputs and YYYY-MM-DD serialization stay intact", () => {
  assert.match(filterBar, /type="date"[\s\S]*value=\{filters\.dateFrom\}/);
  assert.match(filterBar, /type="date"[\s\S]*value=\{filters\.dateTo\}/);
  assert.match(photoTimeDialog, /type="date"[\s\S]*value=\{dateVal\}/);
  assert.match(
    photoTimeDialog,
    /const iso = `\$\{dateVal\}T\$\{timeVal \|\| "00:00"\}:00`/,
  );
  assert.match(timeCapsule, /type="date"[\s\S]*value=\{unlockDate\}/);
  assert.match(timeCapsule, /unlockDate,/);
  assert.match(timeCapsule, /toISOString\(\)\.slice\(0, 10\)/);
  assert.doesNotMatch(
    `${filterBar}\n${photoTimeDialog}\n${timeCapsule}`,
    /type="text"[^>]*(?:dateVal|unlockDate|dateFrom|dateTo)/,
  );
});
