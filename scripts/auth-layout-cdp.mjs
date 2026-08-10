import assert from "node:assert/strict";
import { meetsMinimumTarget } from "./auth-layout-geometry.mjs";
import { waitForCondition } from "./auth-layout-wait.mjs";

const cdpPort = process.env.CDP_PORT ?? "9333";
const pageUrl = process.env.AUTH_PREVIEW_URL ?? "http://127.0.0.1:4173/";
const viewports = [
  { width: 320, height: 800 },
  { width: 390, height: 844 },
  { width: 500, height: 800 },
  { width: 1440, height: 900 },
];
const expectedFont =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForTarget() {
  const deadline = Date.now() + 30_000;
  do {
    try {
      const targets = await fetch(`http://127.0.0.1:${cdpPort}/json`, {
        signal: AbortSignal.timeout(2_000),
      }).then((response) => response.json());
      const target = targets.find(({ url }) => url === pageUrl);
      if (target) return target;
    } catch {
      // Chrome and its DevTools endpoint can start after the preview server.
    }
    await sleep(250);
  } while (Date.now() < deadline);
  throw new Error(`CDP target did not become ready: ${pageUrl}`);
}

const target = await waitForTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    socket.close();
    reject(new Error("CDP WebSocket open timed out"));
  }, 15_000);
  socket.addEventListener("open", () => {
    clearTimeout(timeout);
    resolve();
  }, { once: true });
  socket.addEventListener("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  }, { once: true });
});

let nextId = 0;
let authRequests = 0;
const pending = new Map();

socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) {
    const operation = pending.get(message.id);
    if (!operation) return;
    pending.delete(message.id);
    clearTimeout(operation.timeout);
    if (message.error) operation.reject(new Error(JSON.stringify(message.error)));
    else operation.resolve(message.result);
    return;
  }
  if (
    message.method === "Network.requestWillBeSent"
    && /\/api\/auth\/(?:login|register)(?:$|[/?#])/.test(
      message.params.request.url,
    )
  ) {
    authRequests += 1;
  }
});

function rejectPending(reason) {
  for (const operation of pending.values()) {
    clearTimeout(operation.timeout);
    operation.reject(reason);
  }
  pending.clear();
}

socket.addEventListener("close", () => {
  rejectPending(new Error("CDP connection closed"));
});
socket.addEventListener("error", () => {
  rejectPending(new Error("CDP connection failed"));
});

function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP command timed out: ${method}`));
    }, 15_000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function waitForSelector(selector, { retryPageLoad = false } = {}) {
  const found = await waitForCondition(
    () => evaluate(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    ),
    {
      attempts: retryPageLoad ? 2 : 1,
      onRetry: () => send("Page.reload", { ignoreCache: true }),
    },
  );
  if (found) return;

  const diagnostic = await evaluate(`(() => ({
    href: location.href,
    readyState: document.readyState,
    rootText: document.querySelector("#root")?.textContent?.slice(0, 200) ?? "",
  }))()`);
  throw new Error(
    `Selector did not render: ${selector}; ${JSON.stringify(diagnostic)}`,
  );
}

const snapshotExpression = `(() => {
  const rect = (selector) => {
    const value = document.querySelector(selector)?.getBoundingClientRect();
    return value && {
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height,
    };
  };
  const page = document.querySelector(".auth-page");
  const pageStyle = getComputedStyle(page);
  return {
    document: {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      clientHeight: document.documentElement.clientHeight,
      scrollHeight: document.documentElement.scrollHeight,
    },
    authPage: {
      clientWidth: page.clientWidth,
      scrollWidth: page.scrollWidth,
      clientHeight: page.clientHeight,
      scrollHeight: page.scrollHeight,
      overflowX: pageStyle.overflowX,
      overflowY: pageStyle.overflowY,
    },
    fonts: {
      body: getComputedStyle(document.body).fontFamily,
      username: getComputedStyle(document.querySelector("#login-username")).fontFamily,
      loginTab: getComputedStyle(document.querySelector("#login-tab")).fontFamily,
      passwordToggle: getComputedStyle(
        document.querySelector("#login-password + .auth-password-toggle"),
      ).fontFamily,
      install: getComputedStyle(document.querySelector(".auth-install-button")).fontFamily,
    },
    controls: {
      loginTab: rect("#login-tab"),
      registerTab: rect("#register-tab"),
      username: rect("#login-username"),
      password: rect("#login-password"),
      passwordToggle: rect("#login-password + .auth-password-toggle"),
      submit: rect("#login-panel .auth-submit"),
      install: rect(".auth-install-button"),
    },
  };
})()`;

const scrollSnapshotExpression = `(() => {
  const page = document.querySelector(".auth-page");
  const pageStyle = getComputedStyle(page);
  return {
    document: {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      clientHeight: document.documentElement.clientHeight,
      scrollHeight: document.documentElement.scrollHeight,
    },
    authPage: {
      clientWidth: page.clientWidth,
      scrollWidth: page.scrollWidth,
      clientHeight: page.clientHeight,
      scrollHeight: page.scrollHeight,
      overflowX: pageStyle.overflowX,
      overflowY: pageStyle.overflowY,
    },
  };
})()`;

function assertGeometry(snapshot, width, label) {
  assert.equal(snapshot.document.scrollWidth, snapshot.document.clientWidth, `${label} document overflow`);
  assert.equal(snapshot.authPage.scrollWidth, snapshot.authPage.clientWidth, `${label} auth-page overflow`);
  for (const [name, rect] of Object.entries(snapshot.controls)) {
    assert(rect, `${label} missing ${name}`);
    assert(meetsMinimumTarget(rect.width), `${label} ${name} width ${rect.width}`);
    assert(meetsMinimumTarget(rect.height), `${label} ${name} height ${rect.height}`);
    assert(rect.x >= 0 && rect.x + rect.width <= width, `${label} ${name} outside viewport`);
  }
  for (const [name, font] of Object.entries(snapshot.fonts)) {
    assert.equal(font, expectedFont, `${label} ${name} font drift`);
  }
}

await send("Network.enable");
await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setLocaleOverride", { locale: "en-US" });

const summaries = [];
for (const viewport of viewports) {
  await send("Emulation.setDeviceMetricsOverride", {
    ...viewport,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await send("Page.reload", { ignoreCache: true });
  await waitForSelector("#login-username", { retryPageLoad: true });
  await sleep(200);

  const initial = await evaluate(snapshotExpression);
  assertGeometry(initial, viewport.width, `${viewport.width}px login`);
  if (viewport.width <= 720) {
    assert.equal(initial.authPage.overflowX, "visible");
    assert.equal(initial.authPage.overflowY, "visible");
  }

  const requestBaseline = authRequests;
  await evaluate('document.querySelector("#login-panel form").requestSubmit()');
  await sleep(100);
  const loginValidation = await evaluate(`(() => ({
    activeElement: document.activeElement?.id,
    username: document.querySelector("#login-username").validationMessage,
    password: document.querySelector("#login-password").validationMessage,
  }))()`);
  assert.deepEqual(loginValidation, {
    activeElement: "login-username",
    username: "请输入用户名",
    password: "请输入密码",
  });
  const clearedMessage = await evaluate(`(() => {
    const input = document.querySelector("#login-username");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(
      input,
      "valid-user",
    );
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    return input.validationMessage;
  })()`);
  assert.equal(clearedMessage, "");

  await evaluate('document.querySelector("#register-tab").click()');
  await waitForSelector("#register-panel form");
  await evaluate('document.querySelector("#register-panel form").requestSubmit()');
  await sleep(100);
  const requiredMessages = await evaluate(`(() => ({
    username: document.querySelector("#register-username").validationMessage,
    displayName: document.querySelector("#register-display-name").validationMessage,
    email: document.querySelector("#register-email").validationMessage,
  }))()`);
  assert.deepEqual(requiredMessages, {
    username: "请输入用户名",
    displayName: "请输入昵称",
    email: "请输入邮箱",
  });
  await evaluate(`(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ).set;
    const set = (selector, value) => {
      const input = document.querySelector(selector);
      setter.call(input, value);
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    };
    set("#register-username", "valid-user");
    set("#register-display-name", "有效昵称");
    set("#register-email", "not-an-email");
    set("#register-password", "abcdef");
    set("#register-confirm", "abcdef");
    document.querySelector("#register-panel form").requestSubmit();
  })()`);
  await sleep(100);
  assert.equal(
    await evaluate('document.querySelector("#register-email").validationMessage'),
    "请输入有效的邮箱地址",
  );
  const register = await evaluate(scrollSnapshotExpression);
  assert.equal(register.document.scrollWidth, register.document.clientWidth);
  assert.equal(register.authPage.scrollWidth, register.authPage.clientWidth);
  if (viewport.width <= 720 && register.document.scrollHeight > register.document.clientHeight) {
    assert.equal(register.authPage.scrollHeight, register.authPage.clientHeight);
    assert.equal(register.authPage.overflowY, "visible");
  }
  assert.equal(authRequests, requestBaseline, `${viewport.width}px invalid auth sent a request`);

  summaries.push({
    viewport: `${viewport.width}x${viewport.height}`,
    document: `${initial.document.clientWidth}/${initial.document.scrollWidth}`,
    authPage: `${initial.authPage.clientWidth}/${initial.authPage.scrollWidth}`,
    registerDocumentHeight: `${register.document.clientHeight}/${register.document.scrollHeight}`,
    minimumControl: Math.min(
      ...Object.values(initial.controls).flatMap(({ width, height }) => [width, height]),
    ),
  });
}

console.log(JSON.stringify(summaries, null, 2));
await send("Browser.close").catch(() => {});
socket.close();
