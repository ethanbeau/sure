import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = (await readFile(new URL(
  "../../app/javascript/controllers/session_activity_controller.js",
  import.meta.url,
), "utf8"))
  .replace('import { Controller } from "@hotwired/stimulus";', "class Controller {}")
  .replace("export default class", "globalThis.ActivityController = class");

function setup(inactivityMinutes = 1) {
  let now = 0;
  let wallNow = 0;
  const listeners = new Map();
  const requests = [];
  const redirects = [];
  const timers = new Map();
  let nextTimerId = 0;
  const document = {
    visibilityState: "visible",
    documentElement: { style: { visibility: "" } },
    querySelector: () => ({ content: "csrf-token" }),
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name) => listeners.delete(name),
  };
  const deadlines = () => ({
    server_now: new Date(now).toISOString(),
    inactivity_deadline: new Date(now + inactivityMinutes * 60_000).toISOString(),
    absolute_deadline: null,
  });
  const context = vm.createContext({
    document,
    AbortController,
    Date: class extends Date {
      static now() { return wallNow; }
    },
    performance: { now: () => now },
    window: {
      clearTimeout: (id) => timers.delete(id),
      setTimeout: (callback, delay) => {
        const id = ++nextTimerId;
        timers.set(id, { callback, at: now + delay });
        return id;
      },
      location: { replace: (url) => redirects.push(url) },
    },
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      return { ok: true, status: 200, json: async () => deadlines() };
    },
  });
  vm.runInContext(source, context);
  const createController = (deadlinesValue = JSON.stringify(deadlines())) => {
    const controller = new context.ActivityController();
    controller.urlValue = "/session_activity";
    controller.expiredUrlValue = "/sessions/new?session_expired=true";
    controller.deadlinesValue = deadlinesValue;
    controller.connect();
    return controller;
  };
  const controller = createController();

  return {
    controller, context, document, listeners, requests, redirects, timers, createController,
    advance: (milliseconds) => { now += milliseconds; wallNow += milliseconds; },
    advanceWallClock: (milliseconds) => { wallNow += milliseconds; },
    runTimers: () => {
      for (const [id, timer] of timers) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
    },
    dispatch: (name, event = { isTrusted: true }) => listeners.get(name)?.(event),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("automatic Turbo loads and scroll restoration do not record activity", async () => {
  const app = setup();
  app.dispatch("turbo:load");
  app.dispatch("scroll");
  app.dispatch("input", { isTrusted: false });
  await settle();
  assert.equal(app.requests.length, 0);

  app.dispatch("click");
  await settle();
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].headers["X-User-Activity"], "true");
});

test("one-minute timeouts throttle rapid input and renew during continued use", async () => {
  const app = setup();
  for (let i = 0; i < 10; i++) {
    app.dispatch("keydown");
    await settle();
    app.advance(100);
  }
  assert.equal(app.requests.length, 1);

  app.advance(29_000);
  app.dispatch("wheel");
  await settle();
  assert.equal(app.requests.length, 2);

  app.advance(30_000);
  app.dispatch("input");
  await settle();
  assert.equal(app.requests.length, 3);
});

test("longer timeouts retain the one-minute activity throttle", async () => {
  const app = setup(15);
  app.dispatch("pointerdown");
  await settle();
  app.advance(59_000);
  app.dispatch("keydown");
  await settle();
  assert.equal(app.requests.length, 1);

  app.advance(1_000);
  app.dispatch("keydown");
  await settle();
  assert.equal(app.requests.length, 2);
});

test("an idle deadline check hides the page and redirects on unauthorized", async () => {
  const app = setup();
  app.context.fetch = async (url, options) => {
    app.requests.push({ url, ...options });
    assert.equal(app.document.documentElement.style.visibility, "hidden");
    return { status: 401 };
  };
  app.advance(60_000);
  await app.controller.checkDeadline();
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].headers["X-User-Activity"], undefined);
  assert.deepEqual(app.redirects, [app.controller.expiredUrlValue]);
});

test("waking after expiry revalidates while hiding content when the monotonic clock pauses", async (t) => {
  for (const deadline of ["inactivity_deadline", "absolute_deadline"]) {
    for (const resume of ["visibility", "timer"]) {
      await t.test(`${deadline}, ${resume}`, async () => {
        const app = setup();
        app.controller.applyDeadlines({
          server_now: new Date(0).toISOString(),
          inactivity_deadline: null,
          absolute_deadline: null,
          [deadline]: new Date(60_000).toISOString(),
        });
        app.context.fetch = async (url, options) => {
          app.requests.push({ url, ...options });
          assert.equal(app.document.documentElement.style.visibility, "hidden");
          return { status: 401 };
        };
        // The system slept for two minutes but performance.now() did not tick.
        app.advanceWallClock(120_000);
        if (resume === "visibility") {
          app.document.visibilityState = "visible";
          app.dispatch("visibilitychange");
        } else {
          app.timers.get(app.controller.timeoutTimer).callback();
        }
        assert.equal(app.document.documentElement.style.visibility, "hidden");
        await settle();

        assert.equal(app.requests.length, 1);
        assert.equal(app.requests[0].headers["X-User-Activity"], undefined);
        assert.deepEqual(app.redirects, [app.controller.expiredUrlValue]);
      });
    }
  }
});

test("moving the wall clock backward cannot extend the session", async () => {
  const app = setup();
  app.context.fetch = async () => ({ status: 401 });
  app.advance(60_000);
  app.advanceWallClock(-120_000);
  await app.controller.checkDeadline();

  assert.equal(app.document.documentElement.style.visibility, "hidden");
  assert.deepEqual(app.redirects, [app.controller.expiredUrlValue]);
});

test("disconnect removes activity listeners", async () => {
  const app = setup();
  app.controller.disconnect();
  app.dispatch("keydown");
  await settle();
  assert.equal(app.listeners.size, 0);
  assert.equal(app.requests.length, 0);
  assert.equal(app.timers.size, 0);
});

test("restoring an expired Turbo snapshot revalidates before showing content", async () => {
  const app = setup();
  app.controller.beforeCache();
  const snapshot = app.controller.deadlinesValue;
  app.controller.disconnect();
  app.advance(120_000);
  app.context.fetch = async (url, options) => {
    app.requests.push({ url, ...options });
    return { status: 401 };
  };

  app.createController(snapshot);
  assert.equal(app.document.documentElement.style.visibility, "hidden");
  await settle();

  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].headers["X-User-Activity"], undefined);
  assert.deepEqual(app.redirects, [app.controller.expiredUrlValue]);
});

test("a restored snapshot uses the current server policy", async () => {
  const app = setup();
  app.controller.beforeCache();
  app.controller.disconnect();
  app.advance(120_000);
  app.context.fetch = async () => ({
    ok: true,
    json: async () => ({
      server_now: new Date(120_000).toISOString(),
      inactivity_deadline: null,
      absolute_deadline: null,
    }),
  });

  const restored = app.createController(app.controller.deadlinesValue);
  assert.equal(app.document.documentElement.style.visibility, "hidden");
  await settle();

  assert.equal(app.document.documentElement.style.visibility, "");
  assert.equal(restored.deadlineAt, null);
  assert.equal(app.timers.size, 0);
});

test("disconnect restores visibility and ignores every late check response", async (t) => {
  for (const status of [200, 401, 500]) {
    await t.test(`status ${status}`, async () => {
      const app = setup();
      let respond;
      let signal;
      app.context.fetch = (_url, options) => {
        signal = options.signal;
        return new Promise((resolve) => { respond = resolve; });
      };
      app.document.documentElement.style.visibility = "visible";
      app.advance(60_000);
      const pending = app.controller.checkDeadline();
      assert.equal(app.document.documentElement.style.visibility, "hidden");

      app.controller.disconnect();
      assert.equal(signal.aborted, true);
      assert.equal(app.document.documentElement.style.visibility, "visible");
      assert.equal(app.timers.size, 0);

      respond({ status, ok: status === 200, json: async () => ({}) });
      await pending;
      assert.equal(app.document.documentElement.style.visibility, "visible");
      assert.equal(app.timers.size, 0);
      assert.deepEqual(app.redirects, []);
    });
  }
});

test("a response body completing after reconnect cannot affect the new page", async () => {
  const app = setup();
  let finishBody;
  app.context.fetch = async () => ({
    ok: true,
    json: () => new Promise((resolve) => { finishBody = resolve; }),
  });
  app.dispatch("click");
  await settle();
  app.controller.disconnect();
  app.controller.connect();
  const deadline = app.controller.deadlineAt;

  finishBody({ server_now: new Date(0).toISOString() });
  await settle();

  assert.equal(app.controller.deadlineAt, deadline);
  assert.equal(app.document.documentElement.style.visibility, "");
  assert.deepEqual(app.redirects, []);
});

test("a stalled activity request cannot postpone the absolute deadline", async () => {
  const app = setup();
  app.controller.applyDeadlines({
    server_now: new Date(0).toISOString(),
    inactivity_deadline: null,
    absolute_deadline: new Date(60_000).toISOString(),
  });
  let activitySignal;
  app.context.fetch = async (_url, options) => {
    if (options.headers["X-User-Activity"]) {
      activitySignal = options.signal;
      return new Promise(() => {});
    }
    assert.equal(app.document.documentElement.style.visibility, "hidden");
    return { status: 401 };
  };
  app.dispatch("click");
  app.advance(60_000);
  await app.controller.checkDeadline();

  assert.equal(activitySignal.aborted, true);
  assert.equal(app.document.documentElement.style.visibility, "hidden");
  assert.deepEqual(app.redirects, [app.controller.expiredUrlValue]);
});

test("a stalled deadline request times out and retries while content stays hidden", async () => {
  const app = setup();
  let attempts = 0;
  app.context.fetch = (_url, options) => {
    attempts++;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };
  app.advance(60_000);
  app.runTimers();
  assert.equal(attempts, 1);
  assert.equal(app.document.documentElement.style.visibility, "hidden");

  app.advance(10_000);
  app.runTimers();
  await settle();
  app.advance(5_000);
  app.runTimers();

  assert.equal(attempts, 2);
  assert.equal(app.document.documentElement.style.visibility, "hidden");
  app.controller.disconnect();
  await settle();
  assert.equal(app.timers.size, 0);
});

test("custom duration fields are required only while Custom is selected", async () => {
  const customSource = (await readFile(new URL(
    "../../app/javascript/controllers/session_timeout_custom_controller.js",
    import.meta.url,
  ), "utf8"))
    .replace('import { Controller } from "@hotwired/stimulus";', "class Controller {}")
    .replace("export default class", "globalThis.CustomController = class");
  const context = vm.createContext({});
  vm.runInContext(customSource, context);
  const controller = new context.CustomController();
  controller.selectTarget = { value: "custom" };
  controller.inputTarget = {};
  controller.durationTarget = {};
  controller.connect();
  assert.equal(controller.durationTarget.required, true);
  assert.equal(controller.durationTarget.disabled, false);
  assert.equal(controller.inputTarget.hidden, false);

  controller.selectTarget.value = "";
  controller.toggle();
  assert.equal(controller.durationTarget.required, false);
  assert.equal(controller.durationTarget.disabled, true);
  assert.equal(controller.inputTarget.hidden, true);
});
