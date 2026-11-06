/** 固定SDK随每次构建注入；不采输入内容、完整URL、管理身份或跨应用ID。 */
import { onCLS, onINP, onLCP } from "web-vitals";
const base = import.meta.env.BASE_URL;
const key = "harbor-observation:" + base.split("/").filter(Boolean).at(-1);
const memory = {};
function get(name) {
  try {
    return localStorage.getItem(key + name) ?? memory[name];
  } catch {
    return memory[name];
  }
}
function put(name, value) {
  memory[name] = value;
  try {
    localStorage.setItem(key + name, value);
  } catch {}
}
let visitor = get(":visitor");
if (!/^[a-f0-9-]{36}$/.test(visitor ?? "")) {
  visitor = crypto.randomUUID();
  put(":visitor", visitor);
}
let visit;
let sequence = 0;
let queue = [];
let flushing = false;
let enabled = false;
let pageId = crypto.randomUUID();
function identity() {
  const now = Date.now();
  let saved;
  try {
    saved = JSON.parse(get(":session") ?? "null");
  } catch {}
  if (!saved || now - saved.at > 1800000 || !/^[a-f0-9-]{36}$/.test(saved.id)) {
    saved = { id: crypto.randomUUID() };
  }
  visit = saved.id;
  put(":session", JSON.stringify({ id: visit, at: now }));
  return {
    anonymousId: visitor,
    sessionId: visit,
    clientRevisionId: __APP_REVISION__,
  };
}
function channel() {
  const value = new URLSearchParams(location.search).get("utm_source");
  return value && /^[a-zA-Z0-9_-]{1,40}$/.test(value) ? value : "unknown";
}
function track(eventName, properties = {}) {
  if (!enabled || queue.length >= 200) return;
  queue.push({
    eventId: crypto.randomUUID(),
    eventName,
    eventVersion: __APP_ANALYTICS__.events?.[eventName]?.version ?? 1,
    occurredAt: Date.now(),
    ...identity(),
    properties,
  });
  if (queue.length >= 20) void flush();
}
async function flush() {
  if (flushing || !queue.length) return;
  flushing = true;
  const batch = queue.splice(0, 20);
  try {
    const r = await fetch(base + "__harbor/observe/browser", {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: batch }),
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok && queue.length < 180) queue.unshift(...batch);
  } catch {
    if (queue.length < 180) queue.unshift(...batch);
  } finally {
    queue = queue.filter((e) => Date.now() - e.occurredAt < 120000);
    flushing = false;
  }
}
function page() {
  pageId = crypto.randomUUID();
  track("page_view", {
    page: location.pathname === base ? "/" : "other",
    channel: channel(),
    device: matchMedia("(max-width: 767px)").matches ? "mobile" : "desktop",
    sequence: ++sequence,
  });
}
const originalFetch = window.fetch.bind(window);
// 只为当前应用业务API附加匿名关联信息，不改变其他fetch或管理Cookie策略。
window.fetch = (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    location.href,
  );
  if (
    enabled &&
    url.origin === location.origin &&
    url.pathname.startsWith(base + "api/")
  ) {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const ids = identity();
    headers.set("X-App-Visitor", ids.anonymousId);
    headers.set("X-App-Visit", ids.sessionId);
    return originalFetch(input, { ...init, headers });
  }
  return originalFetch(input, init);
};
window.harbor = {
  track,
  resetIdentity() {
    visitor = crypto.randomUUID();
    put(":visitor", visitor);
    put(":session", "null");
  },
  disable() {
    enabled = false;
    queue = [];
  },
};
async function start() {
  try {
    const r = await originalFetch(base + "__harbor/health", {
      credentials: "omit",
    });
    const health = await r.json();
    enabled = health.observationVersion === 1;
  } catch {
    return;
  }
  if (!enabled) return;
  page();
  for (const method of ["pushState", "replaceState"]) {
    const previous = history[method].bind(history);
    history[method] = function (...args) {
      const before = location.pathname + location.search;
      const result = previous(...args);
      if (before !== location.pathname + location.search) page();
      return result;
    };
  }
  addEventListener("popstate", page);
  const kinds = [
    "Error",
    "TypeError",
    "ReferenceError",
    "SyntaxError",
    "RangeError",
  ];
  addEventListener("error", (e) =>
    track("page_error", {
      kind: kinds.includes(e.error?.name) ? e.error.name : "ResourceError",
      line: e.lineno ?? 0,
      column: e.colno ?? 0,
    }),
  );
  addEventListener("unhandledrejection", () =>
    track("page_error", { kind: "PromiseRejection" }),
  );
  for (const observe of [onCLS, onINP, onLCP])
    observe((metric) =>
      track("web_vital", {
        metric: metric.name,
        value: metric.value,
        metricId: metric.id.replace(/[^a-zA-Z0-9_:-]/g, "").slice(0, 80),
      }),
    );
  setInterval(() => void flush(), 5000);
  addEventListener("pagehide", () => {
    if (queue.length) {
      const events = queue.splice(0, 20);
      navigator.sendBeacon(
        base + "__harbor/observe/browser",
        new Blob([JSON.stringify({ events })], { type: "application/json" }),
      );
    }
  });
}
void start();
