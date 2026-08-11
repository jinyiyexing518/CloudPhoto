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
const authenticatedApp = read("packages/client/src/AuthenticatedApp.tsx");
const privateMomentsStore = read(
  "packages/client/src/services/privateMomentsStore.ts",
);
const photoApi = read("packages/client/src/services/photoApi.ts");
const settingsDialog = read(
  "packages/client/src/components/settings/SettingsDialog.tsx",
);
const momentInsightsApi = read(
  "packages/server/src/functions/moments/manageMomentInsights.ts",
);
const dateHelperPath = join(
  repoRoot,
  "packages/client/src/utils/dateFormat.ts",
);
const dateHelper = readFileSync(dateHelperPath, "utf8");

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
  assert.equal(declaration(capsuleClose, "color"), "#6b7280");
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
    /getFirstLocalCalendarDateKey\(photo\.takenAt,\s*photo\.createdAt,\s*photo\.lastModified\)/,
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
  assert.match(timeCapsule, /getLocalCalendarDateKey/);
  assert.match(timeCapsule, /return getLocalCalendarDateKey\(d\)/);
  assert.match(timeCapsule, /const today = getLocalCalendarDateKey\(now\)/);
  assert.match(timeCapsule, /createdAt: today/);
  assert.match(timeCapsule, /min=\{minimumUnlockDate\}/);
  assert.match(timeCapsule, /unlockDate < minimumUnlockDate/);
  assert.match(timeCapsule, /getPhotoCalendarDayDistance\(c\.unlockDate, now\)/);
  assert.match(
    timeCapsule,
    /disabled=\{!title\.trim\(\) \|\| selectedNames\.size === 0 \|\| unlockDate < minimumUnlockDate\}/,
  );
  assert.doesNotMatch(timeCapsule, /toISOString\(\)\.slice\(0, 10\)/);
  assert.doesNotMatch(
    `${filterBar}\n${photoTimeDialog}\n${timeCapsule}`,
    /type="text"[^>]*(?:dateVal|unlockDate|dateFrom|dateTo)/,
  );

  const helperUrl = pathToFileURL(dateHelperPath).href;
  const cases = [
    ["Asia/Shanghai", "2026-08-10T16:30:00.000Z", "2026-08-11", "2026-08-12"],
    ["America/Los_Angeles", "2026-08-11T01:30:00.000Z", "2026-08-10", "2026-08-11"],
  ];
  for (const [timezone, instant, expected, target] of cases) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const { getLocalCalendarDateKey, getPhotoCalendarDayDistance } = await import(${JSON.stringify(helperUrl + `?tz=${timezone}`)}); const now = new Date(${JSON.stringify(instant)}); console.log(JSON.stringify({ key: getLocalCalendarDateKey(now), days: getPhotoCalendarDayDistance(${JSON.stringify(target)}, now) }));`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, TZ: timezone },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), { key: expected, days: 1 }, timezone);
  }
});

test("capsule tomorrow uses shared local calendar addition across midnight and DST", () => {
  assert.match(timeCapsule, /addLocalCalendarDays/);
  assert.match(
    timeCapsule,
    /const minimumUnlockDate = addLocalCalendarDays\(now,\s*1\)/,
  );
  assert.doesNotMatch(timeCapsule, /setDate\(/);
  assert.doesNotMatch(timeCapsule, /86_?400_?000|86400000/);

  const helperUrl = pathToFileURL(dateHelperPath).href;
  const cases = [
    ["Asia/Shanghai", "2026-08-10T16:30:00.000Z", 1, "2026-08-12"],
    ["America/New_York", "2026-03-08T06:30:00.000Z", 1, "2026-03-09"],
    ["America/New_York", "2026-11-01T05:30:00.000Z", 1, "2026-11-02"],
    ["America/New_York", "2026-03-08", 1, "2026-03-09"],
    ["Asia/Shanghai", "2024-02-28", 1, "2024-02-29"],
  ];

  for (const [timezone, value, days, expected] of cases) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const { addLocalCalendarDays } = await import(${JSON.stringify(helperUrl + `?add-days=${timezone}-${value}`)}); console.log(addLocalCalendarDays(${JSON.stringify(value)}, ${days}));`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, TZ: timezone },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected, `${timezone} ${value}`);
  }

  const invalidResult = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const { addLocalCalendarDays } = await import(${JSON.stringify(helperUrl + "?add-days=invalid")}); console.log(JSON.stringify([addLocalCalendarDays("not-a-date", 1), addLocalCalendarDays("2026-02-30", 1), addLocalCalendarDays("2026-08-11", 1.5)]));`,
    ],
    { encoding: "utf8", env: { ...process.env, TZ: "Asia/Shanghai" } },
  );
  assert.equal(invalidResult.status, 0, invalidResult.stderr);
  assert.deepEqual(JSON.parse(invalidResult.stdout.trim()), ["", "", ""]);
});

test("capsule countdown compares local calendar ordinals and fails safe for invalid dates", () => {
  assert.match(
    dateHelper,
    /function getLocalCalendarDayOrdinal[\s\S]*getLocalCalendarDateKey\(value\)[\s\S]*Date\.UTC\(year, month - 1, day\)/,
  );
  assert.match(
    dateHelper,
    /return targetOrdinal - currentOrdinal/,
  );
  assert.doesNotMatch(
    dateHelper,
    /getPhotoCalendarDayDistance[\s\S]{0,500}Math\.(?:ceil|round)|getPhotoCalendarDayDistance[\s\S]{0,500}\.getTime\(\)/,
  );
  assert.match(
    timeCapsule,
    /const daysLeft = getPhotoCalendarDayDistance\(c\.unlockDate,\s*now\)/,
  );
  assert.match(timeCapsule, /daysLeft === null/);
  assert.match(timeCapsule, /解锁日期无效/);
  assert.doesNotMatch(timeCapsule, /getPhotoCalendarDayDistance\([^)]*\) \?\? 1/);
  assert.doesNotMatch(timeCapsule, /new Date\(c\.unlockDate\)/);
  assert.doesNotMatch(timeCapsule, /Math\.ceil\([^)]*86_?400_?000|86400000/);

  const helperUrl = pathToFileURL(dateHelperPath).href;
  const cases = [
    ["Asia/Shanghai", "2026-08-10T16:30:00.000Z", "2026-08-11", 0],
    ["Asia/Shanghai", "2026-08-10T16:30:00.000Z", "2026-08-12", 1],
    ["America/New_York", "2026-03-08T06:30:00.000Z", "2026-03-09", 1],
    ["America/New_York", "2026-11-01T05:30:00.000Z", "2026-11-02", 1],
    ["America/Los_Angeles", "2026-08-11T01:30:00.000Z", "2026-08-09", -1],
  ];

  for (const [timezone, reference, target, expected] of cases) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const { getPhotoCalendarDayDistance } = await import(${JSON.stringify(helperUrl + `?distance=${timezone}-${reference}-${target}`)}); console.log(JSON.stringify(getPhotoCalendarDayDistance(${JSON.stringify(target)}, ${JSON.stringify(reference)})));`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, TZ: timezone },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim()), expected, `${timezone} ${target}`);
  }

  const invalidResult = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const { getPhotoCalendarDayDistance } = await import(${JSON.stringify(helperUrl + "?distance=invalid")}); console.log(JSON.stringify([getPhotoCalendarDayDistance("not-a-date", "2026-08-11"), getPhotoCalendarDayDistance("2026-02-30", "2026-08-11"), getPhotoCalendarDayDistance("2026-08-12", "invalid")]));`,
    ],
    { encoding: "utf8", env: { ...process.env, TZ: "Asia/Shanghai" } },
  );
  assert.equal(invalidResult.status, 0, invalidResult.stderr);
  assert.deepEqual(JSON.parse(invalidResult.stdout.trim()), [null, null, null]);
});

test("one local calendar policy drives timeline, filters, uploads, and moment stats", () => {
  assert.doesNotMatch(authenticatedApp, /function (?:formatLocalDate|toLocalDateKey)\(/);
  assert.match(authenticatedApp, /getLocalCalendarDateKey/);
  assert.match(authenticatedApp, /getFirstLocalCalendarDateKey/);
  assert.match(photoGallery, /getFirstLocalCalendarDateKey\(photo\.takenAt,\s*photo\.createdAt,\s*photo\.lastModified\)/);
  assert.match(privateMomentsStore, /getLocalCalendarDateKey\(viewedAt\)/);
  assert.doesNotMatch(privateMomentsStore, /viewedAt\.slice\(0,\s*10\)/);
  assert.match(photoGallery, /recordMomentViewApi\(photoName,\s*localDateKey,\s*userName\)/);
  assert.match(folderView, /recordMomentViewApi\(photoName,\s*getLocalCalendarDateKey\(new Date\(\)\),\s*userName\)/);
  assert.match(photoApi, /localDateKey: string,\s*viewerName\?: string/);
  assert.match(photoApi, /JSON\.stringify\(\{\s*photoName,\s*viewerName,\s*localDateKey\s*\}\)/);
  assert.match(momentInsightsApi, /const today = normalizeLocalDateKey\(suppliedDateKey\)/);
  assert.match(momentInsightsApi, /if \(suppliedDateKey && !today\)/);
  assert.match(momentInsightsApi, /path: `\/dailyViews\/\$\{today\}`/);
  assert.match(momentInsightsApi, /dailyViews: today \? \{ \[today\]: 1 \} : \{\}/);
  assert.doesNotMatch(momentInsightsApi, /new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/);
  assert.match(settingsDialog, /formatPhotoDateTimeSeconds/);
  assert.doesNotMatch(
    settingsDialog,
    /toLocale(?:DateString|TimeString|String)\(\s*(?:undefined\s*[,)]|\))/,
  );

  const helperUrl = pathToFileURL(dateHelperPath).href;
  const cases = [
    ["Asia/Shanghai", "2026-08-10T16:30:00.000Z", "2026-08-11", "2026年8月11日"],
    ["America/New_York", "2026-03-08T06:30:00.000Z", "2026-03-08", "2026年3月8日"],
    ["America/New_York", "2026-03-08T07:30:00.000Z", "2026-03-08", "2026年3月8日"],
    ["America/New_York", "2026-11-01T03:30:00.000Z", "2026-10-31", "2026年10月31日"],
    ["America/New_York", "2026-11-01T05:30:00.000Z", "2026-11-01", "2026年11月1日"],
  ];

  for (const [timezone, instant, expectedKey, expectedLabel] of cases) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const { formatPhotoGroupDate, getFirstLocalCalendarDateKey, getLocalCalendarDateKey } = await import(${JSON.stringify(helperUrl + `?calendar=${timezone}-${instant}`)}); const key = getLocalCalendarDateKey(${JSON.stringify(instant)}); console.log(JSON.stringify({ key, first: getFirstLocalCalendarDateKey("invalid", ${JSON.stringify(instant)}), label: formatPhotoGroupDate(key) }));`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, TZ: timezone },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout.trim()),
      { key: expectedKey, first: expectedKey, label: expectedLabel },
      `${timezone} ${instant}`,
    );
  }

  const invalidResult = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const { getFirstLocalCalendarDateKey, getLocalCalendarDateKey } = await import(${JSON.stringify(helperUrl + "?calendar=invalid")}); console.log(JSON.stringify({ empty: getLocalCalendarDateKey(""), invalid: getLocalCalendarDateKey("not-a-date"), impossible: getLocalCalendarDateKey("2026-02-30"), first: getFirstLocalCalendarDateKey("invalid", "2026-02-30") }));`,
    ],
    { encoding: "utf8", env: { ...process.env, TZ: "Asia/Shanghai" } },
  );
  assert.equal(invalidResult.status, 0, invalidResult.stderr);
  assert.deepEqual(JSON.parse(invalidResult.stdout.trim()), {
    empty: "",
    invalid: "",
    impossible: "",
    first: "",
  });
});
