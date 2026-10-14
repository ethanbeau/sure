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

const layout = await readFile(new URL(
  "../../app/views/layouts/shared/_htmldoc.html.erb",
  import.meta.url,
), "utf8");
const actions = { document: new Map(), window: new Map() };
for (const [, event, target, method] of layout.matchAll(
  /([\w:-]+)@(document|window)->session-activity#(\w+)/g,
)) {
  actions[target].set(event, method);
}

function setup(inactivityMinutes = 1, hideInBackground = true) {
  let now = 0;
  let wallNow = 0;
  let activeController;
  const requests = [];
  const redirects = [];
  const reloads = [];
  const timers = new Map();
  const observers = new Set();
  let nextTimerId = 0;
  const body = { style: { opacity: "" }, dataset: {}, querySelectorAll: () => [] };
  const document = {
    body,
    visibilityState: "visible",
    hasFocus: () => true,
    documentElement: { style: { visibility: "" } },
    querySelector: () => ({ content: "csrf-token" }),
  };
  const deadlines = () => ({
    server_now: new Date(now).toISOString(),
    inactivity_deadline: inactivityMinutes === null
      ? null
      : new Date(now + inactivityMinutes * 60_000).toISOString(),
    absolute_deadline: null,
  });
  const context = vm.createContext({
    document,
    AbortController,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(target, options) {
        this.target = target;
        this.options = options;
        observers.add(this);
      }
      disconnect() { observers.delete(this); }
    },
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
      location: { search: "", replace: (url) => redirects.push(url), reload: () => reloads.push(true) },
    },
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      return { ok: true, status: 200, json: async () => deadlines() };
    },
  });
  vm.runInContext(source, context);
  const createController = (deadlinesValue = JSON.stringify(deadlines())) => {
    const controller = new context.ActivityController();
    controller.element = body;
    controller.urlValue = "/session_activity";
    controller.expiredUrlValue = "/sessions/new?session_expired=true";
    controller.deadlinesValue = deadlinesValue;
    controller.hideInBackgroundValue = hideInBackground;
    controller.connect();
    activeController = controller;
    return controller;
  };
  const controller = createController();
  // Stimulus dispatches declarative actions only to connected controllers.
  const dispatchAction = (target, name, event) => {
    const method = actions[target].get(name);
    if (activeController.connected && method) activeController[method](event);
  };

  return {
    controller, context, document, requests, redirects, reloads, timers, createController,
    advance: (milliseconds) => { now += milliseconds; wallNow += milliseconds; },
    advanceWallClock: (milliseconds) => { wallNow += milliseconds; },
    runTimers: () => {
      for (const [id, timer] of timers) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
    },
    dispatch: (name, event = { isTrusted: true }) => dispatchAction("document", name, event),
    dispatchWindow: (name, event = {}) => dispatchAction("window", name, event),
    observers,
    mutate: () => { for (const observer of observers) observer.callback(); },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("Turbo deadline changes enable expiration checks without reconnecting", async (t) => {
  for (const deadline of ["inactivity_deadline", "absolute_deadline"]) {
    await t.test(deadline, async () => {
      const app = setup(null);
      assert.equal(app.controller.deadlineAt, null);
      assert.equal(app.timers.size, 0);
      app.context.fetch = async (url, options) => {
        app.requests.push({ url, ...options });
        return { status: 401 };
      };

      app.controller.deadlinesValue = JSON.stringify({
        server_now: new Date(0).toISOString(),
        inactivity_deadline: null,
        absolute_deadline: null,
        [deadline]: new Date(60_000).toISOString(),
      });
      app.controller.deadlinesValueChanged(app.controller.deadlinesValue);
      app.advance(60_000);
      app.runTimers();
      assert.equal(app.document.body.style.opacity, "0");
      await settle();

      assert.equal(app.requests.length, 1);
      assert.equal(app.requests[0].headers["X-User-Activity"], undefined);
      assert.deepEqual(app.redirects, [app.controller.expiredUrlValue]);
    });
  }
});

test("Turbo deadline changes replace the existing expiration timer", () => {
  const app = setup(15);
  const previousTimer = app.controller.timeoutTimer;
  app.controller.deadlinesValueChanged(JSON.stringify({
    server_now: new Date(0).toISOString(),
    inactivity_deadline: new Date(60_000).toISOString(),
    absolute_deadline: null,
  }));

  assert.equal(app.timers.has(previousTimer), false);
  assert.equal(app.timers.size, 1);
  assert.equal(app.timers.get(app.controller.timeoutTimer).at, 60_000);
  assert.equal(app.controller.activityThrottleMs, 30_000);

  app.controller.deadlinesValueChanged(JSON.stringify({
    server_now: new Date(0).toISOString(),
    inactivity_deadline: null,
    absolute_deadline: null,
  }));
  assert.equal(app.controller.deadlineAt, null);
  assert.equal(app.timers.size, 0);
});

test("clearing deadlines for Turbo caching preserves the live expiration timer", () => {
  const app = setup();
  const previousTimer = app.controller.timeoutTimer;
  app.controller.beforeCache();
  app.controller.deadlinesValueChanged(app.controller.deadlinesValue);

  assert.equal(app.controller.deadlineAt, 60_000);
  assert.equal(app.timers.has(previousTimer), true);
  assert.equal(app.requests.length, 0);
});

test("deadline value callbacks before connect or after disconnect do not schedule timers", () => {
  const app = setup();
  const unconnected = new app.context.ActivityController();
  unconnected.deadlinesValueChanged(app.controller.deadlinesValue);

  app.controller.disconnect();
  app.controller.deadlinesValueChanged(app.controller.deadlinesValue);
  assert.equal(app.timers.size, 0);
});

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
    assert.equal(app.document.body.style.opacity, "0");
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
          assert.equal(app.document.body.style.opacity, "0");
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
        assert.equal(app.document.body.style.opacity, "0");
        await settle();

        assert.equal(app.requests.length, 1);
        assert.equal(app.requests[0].headers["X-User-Activity"], undefined);
        assert.deepEqual(app.redirects, [app.controller.expiredUrlValue]);
      });
    }
  }
});

test("returning from the background revalidates before showing private content", async () => {
  const app = setup();
  app.dispatchWindow("pagehide");
  assert.equal(app.document.body.style.opacity, "0");

  app.advance(120_000);
  app.context.fetch = async (url, options) => {
    app.requests.push({ url, ...options });
    assert.equal(app.document.body.style.opacity, "0");
    return { status: 401 };
  };
  app.dispatchWindow("pageshow", { persisted: true });
  await settle();

  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].headers["X-User-Activity"], undefined);
  assert.deepEqual(app.redirects, [app.controller.expiredUrlValue]);
  assert.equal(app.document.body.style.opacity, "0");
});

test("switching tabs covers the page and returning checks the session", async () => {
  const app = setup();
  app.document.visibilityState = "hidden";
  app.dispatch("visibilitychange");
  assert.equal(app.document.body.style.opacity, "0");

  app.context.fetch = async (url, options) => {
    app.requests.push({ url, ...options });
    return { status: 401 };
  };
  app.document.visibilityState = "visible";
  app.dispatch("visibilitychange");
  await settle();

  assert.equal(app.requests.length, 1);
  assert.deepEqual(app.redirects, [app.controller.expiredUrlValue]);
  assert.equal(app.document.body.style.opacity, "0");
});

test("pagehide covers the entire page when mounted on a small element", async () => {
  const app = setup();
  app.controller.element = { style: { opacity: "" }, dataset: {}, querySelectorAll: () => [] };
  app.document.body.style.opacity = "0.9";
  const elements = [{ style: { opacity: "0.8" }, dataset: {} }];
  app.document.body.querySelectorAll = () => elements;

  app.dispatchWindow("pagehide");
  assert.equal(app.document.visibilityState, "visible");
  assert.equal(app.document.body.style.opacity, "0");
  assert.equal(elements[0].style.opacity, "0");
  assert.equal([...app.observers][0].target, app.document.body);

  // A Turbo response can insert a popover outside the controller while backgrounded.
  const popover = { style: { opacity: "" }, dataset: {} };
  elements.push(popover);
  app.mutate();
  assert.equal(popover.style.opacity, "0");

  app.dispatchWindow("focus");
  assert.equal(app.document.body.style.opacity, "0.9");
  assert.equal(elements[0].style.opacity, "0.8");
  assert.equal(popover.style.opacity, "");
  assert.equal(app.observers.size, 0);
  await settle();
});

test("moving the wall clock backward cannot extend the session", async () => {
  const app = setup();
  app.context.fetch = async () => ({ status: 401 });
  app.advance(60_000);
  app.advanceWallClock(-120_000);
  await app.controller.checkDeadline();

  assert.equal(app.document.body.style.opacity, "0");
  assert.deepEqual(app.redirects, [app.controller.expiredUrlValue]);
});

test("disconnect stops responding to activity and resume actions", async () => {
  const app = setup();
  app.controller.disconnect();
  app.dispatch("keydown");
  app.dispatchWindow("focus");
  await settle();
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
  assert.equal(app.document.body.style.opacity, "0");
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
  assert.equal(app.document.body.style.opacity, "0");
  await settle();

  assert.equal(app.document.body.style.opacity, "");
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
      assert.equal(app.document.body.style.opacity, "0");

      app.controller.disconnect();
      assert.equal(signal.aborted, true);
      assert.equal(app.document.body.style.opacity, "");
      assert.equal(app.document.documentElement.style.visibility, "visible");
      assert.equal(app.timers.size, 0);

      respond({ status, ok: status === 200, json: async () => ({}) });
      await pending;
      assert.equal(app.document.body.style.opacity, "");
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
  assert.equal(app.document.body.style.opacity, "");
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
    assert.equal(app.document.body.style.opacity, "0");
    return { status: 401 };
  };
  app.dispatch("click");
  app.advance(60_000);
  await app.controller.checkDeadline();

  assert.equal(activitySignal.aborted, true);
  assert.equal(app.document.body.style.opacity, "0");
  assert.deepEqual(app.redirects, [app.controller.expiredUrlValue]);
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


test("Safari resume events immediately restore a page before its known deadline", async (t) => {
  for (const [leave, resume] of [["pagehide", "pageshow"], ["hidden", "visible"]]) {
    await t.test(`${leave} / ${resume}`, async () => {
      const app = setup();
      if (leave === "hidden") {
        app.document.visibilityState = "hidden";
        app.dispatch("visibilitychange");
      } else {
        app.dispatchWindow(leave);
      }
      assert.equal(app.document.body.style.opacity, "0");
      assert.equal(app.document.documentElement.style.visibility, "");
      if (resume === "visible") {
        app.document.visibilityState = "visible";
        app.dispatch("visibilitychange");
      } else {
        app.dispatchWindow(resume);
      }
      app.dispatchWindow("focus");
      await settle();
      assert.equal(app.document.body.style.opacity, "");
      assert.equal(app.requests.length, 1);
      assert.equal(app.requests[0].headers["X-User-Activity"], undefined);
      assert.equal(app.requests[0].cache, "no-store");
      assert.deepEqual(app.redirects, []);
    });
  }
});

test("a renewal finishing in the background cannot remove the privacy cover", async () => {
  const app = setup();
  let respond;
  app.context.fetch = () => new Promise((resolve) => { respond = resolve; });
  app.dispatch("click");
  app.document.visibilityState = "hidden";
  app.dispatch("visibilitychange");
  respond({ ok: true, json: async () => ({ server_now: new Date(0).toISOString() }) });
  await settle();
  assert.equal(app.document.body.style.opacity, "0");
  assert.equal(app.controller.resumeValidationRequired, true);
});

test("returning starts a fresh check even if a background request never settles", async () => {
  const app = setup();
  let signal;
  app.context.fetch = (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  };
  app.dispatch("click");
  app.dispatchWindow("pagehide");
  assert.equal(signal.aborted, true);
  app.context.fetch = async () => ({ ok: true, json: async () => ({
    server_now: new Date(0).toISOString(),
    inactivity_deadline: new Date(60_000).toISOString(),
  }) });
  app.dispatchWindow("focus");
  await settle();
  assert.equal(app.document.body.style.opacity, "");
});

test("a resume check completing after another pagehide cannot reveal the page", async () => {
  const app = setup();
  let respond;
  app.context.fetch = () => new Promise((resolve) => { respond = resolve; });
  app.dispatchWindow("pagehide");
  app.dispatchWindow("focus");
  app.dispatchWindow("pagehide");
  respond({ ok: true, json: async () => ({ server_now: new Date(0).toISOString() }) });
  await settle();
  assert.equal(app.document.body.style.opacity, "0");
});

test("focus while hidden cannot reveal content or start a check", async () => {
  const app = setup();
  app.document.visibilityState = "hidden";
  app.dispatch("visibilitychange");
  app.dispatchWindow("focus");
  app.dispatchWindow("pageshow");
  await settle();
  assert.equal(app.document.body.style.opacity, "0");
  assert.equal(app.requests.length, 0);
});

test("cached privacy cover is removed after a snapshot validates", async () => {
  const app = setup();
  app.controller.beforeCache();
  app.controller.disconnect();
  app.document.body.style.opacity = "0";
  app.document.body.dataset.sessionPrivacyOpacity = "";
  app.createController("");
  assert.equal(app.document.body.style.opacity, "0");
  await settle();
  assert.equal(app.document.body.style.opacity, "");
});

test("resume restores the page when both timeout policies are disabled", async () => {
  const app = setup();
  app.controller.applyDeadlines({ server_now: new Date(0).toISOString() });
  app.dispatchWindow("pagehide");
  app.context.fetch = async () => ({ ok: true, json: async () => ({
    server_now: new Date(0).toISOString(),
    inactivity_deadline: null,
    absolute_deadline: null,
  }) });
  app.dispatchWindow("focus");
  await settle();
  assert.equal(app.document.body.style.opacity, "");
  assert.equal(app.timers.size, 0);
});


test("a touch recovers a covered page when Safari omits resume events", async () => {
  const app = setup();
  app.dispatchWindow("pagehide");
  app.dispatch("touchstart");
  await settle();
  assert.equal(app.document.body.style.opacity, "");
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].headers["X-User-Activity"], undefined);
});



test("valid resume uncovers immediately even when the session check stalls", async () => {
  const app = setup();
  app.context.fetch = () => new Promise(() => {});
  app.dispatchWindow("pagehide");
  app.dispatchWindow("focus");
  assert.equal(app.document.body.style.opacity, "");
  assert.equal(app.controller.pendingRequest !== null, true);
  app.controller.disconnect();
});

test("timers cannot uncover the page while the page remains backgrounded", async () => {
  const app = setup();
  app.document.hasFocus = () => false;
  app.dispatchWindow("pagehide");
  app.advance(120_000);
  app.runTimers();
  await settle();
  assert.equal(app.document.body.style.opacity, "0");
  assert.equal(app.requests.length, 0);
});

test("expired validation failure reloads instead of leaving a permanent cover", async () => {
  const app = setup();
  app.dispatchWindow("pagehide");
  app.advance(120_000);
  app.context.fetch = async () => ({ ok: false, status: 422 });
  app.dispatchWindow("focus");
  await settle();
  assert.deepEqual(app.reloads, [true]);
  assert.equal(app.document.body.style.opacity, "0");
});

test("expired validation timeout reloads without requiring a manual refresh", async () => {
  const app = setup();
  app.context.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  app.advance(60_000);
  app.controller.checkDeadline();
  app.advance(10_000);
  app.runTimers();
  await settle();
  assert.deepEqual(app.reloads, [true]);
  assert.equal(app.document.body.style.opacity, "0");
});

test("repeated swipe and resume cycles preserve original opacity, including dialogs", async () => {
  const app = setup();
  const dialog = { style: { opacity: "0.8" }, dataset: {} };
  app.document.body.querySelectorAll = () => [dialog];
  for (let i = 0; i < 3; i++) {
    app.dispatchWindow("pagehide");
    app.document.visibilityState = "hidden";
    app.dispatch("visibilitychange");
    assert.equal(app.document.body.style.opacity, "0");
    assert.equal(dialog.style.opacity, "0");
    app.dispatchWindow("focus");
    assert.equal(app.document.body.style.opacity, "0");
    app.document.visibilityState = "visible";
    app.dispatch("visibilitychange");
    assert.equal(app.document.body.style.opacity, "");
    assert.equal(dialog.style.opacity, "0.8");
    await settle();
  }
});

test("content inserted while covered stays hidden until resume or validation", async (t) => {
  for (const expired of [false, true]) {
    await t.test(expired ? "expired session validation" : "unexpired resume", async () => {
      const app = setup();
      const elements = [];
      app.document.body.querySelectorAll = () => elements;
      app.dispatchWindow("pagehide");
      const observer = [...app.observers][0];
      assert.equal(observer.target, app.document.body);
      assert.equal(observer.options.childList, true);
      assert.equal(observer.options.subtree, true);
      assert.equal(observer.options.attributes, true);
      assert.deepEqual(Array.from(observer.options.attributeFilter), ["popover"]);

      const dialog = { style: { opacity: "0.8" }, dataset: {} };
      const popover = { style: { opacity: "" }, dataset: {} };
      elements.push(dialog, popover);
      app.mutate();
      app.mutate();
      assert.equal(dialog.style.opacity, "0");
      assert.equal(popover.style.opacity, "0");
      assert.equal(app.observers.size, 1);

      let respond;
      app.context.fetch = () => new Promise((resolve) => { respond = resolve; });
      if (expired) app.advance(120_000);
      app.dispatchWindow("focus");
      assert.equal(dialog.style.opacity, expired ? "0" : "0.8");
      assert.equal(popover.style.opacity, expired ? "0" : "");
      respond({ ok: true, json: async () => ({ server_now: new Date(120_000).toISOString() }) });
      await settle();
      assert.equal(dialog.style.opacity, "0.8");
      assert.equal(popover.style.opacity, "");
      assert.equal(app.observers.size, 0);
      assert.equal("sessionPrivacyOpacity" in dialog.dataset, false);
      // A queued callback from the stopped observer must not cover the page.
      observer.callback();
      assert.equal(dialog.style.opacity, "0.8");
    });
  }
});

test("disconnect stops observing and restores content inserted while covered", () => {
  const app = setup();
  app.dispatchWindow("pagehide");
  const dialog = { style: { opacity: "0.6" }, dataset: {} };
  app.document.body.querySelectorAll = () => [dialog];
  app.mutate();
  assert.equal(dialog.style.opacity, "0");
  app.controller.disconnect();
  assert.equal(dialog.style.opacity, "0.6");
  assert.equal(app.observers.size, 0);
});


test("fresh server-rendered content removes a cover inherited during morphing", async () => {
  const app = setup();
  app.controller.disconnect();
  app.document.body.style.opacity = "0";
  app.document.body.dataset.sessionPrivacyOpacity = "";
  app.createController();
  assert.equal(app.document.body.style.opacity, "");
});

test("a failed background validation cannot blank a locally unexpired page", async () => {
  const app = setup();
  app.dispatchWindow("pagehide");
  app.context.fetch = async () => ({ ok: false, status: 500 });
  app.dispatchWindow("focus");
  assert.equal(app.document.body.style.opacity, "");
  await settle();
  assert.equal(app.document.body.style.opacity, "");
  assert.deepEqual(app.reloads, []);
});


test("focus arriving before visible resumes when visibility catches up", async () => {
  const app = setup();
  app.dispatchWindow("pagehide");
  app.document.visibilityState = "hidden";
  app.dispatch("visibilitychange");
  app.dispatchWindow("focus");
  assert.equal(app.document.body.style.opacity, "0");
  app.document.visibilityState = "visible";
  app.dispatch("visibilitychange");
  assert.equal(app.document.body.style.opacity, "");
  await settle();
  assert.equal(app.requests.length, 1);
});



test("fresh pages remain visible even if Safari reports hasFocus false", async () => {
  const app = setup();
  app.controller.disconnect();
  app.document.hasFocus = () => false;
  app.createController();
  assert.equal(app.document.body.style.opacity, "");
  app.dispatchWindow("pageshow");
  assert.equal(app.document.body.style.opacity, "");
  await settle();
});

test("Safari resume restores after pagehide without a focus event or reported focus", async (t) => {
  for (const resume of ["visibilitychange", "persisted pageshow"]) {
    await t.test(resume, async () => {
      const app = setup();
      app.document.hasFocus = () => false;
      app.dispatchWindow("pagehide");
      assert.equal(app.document.body.style.opacity, "0");

      if (resume === "visibilitychange") {
        app.document.visibilityState = "hidden";
        app.dispatch("visibilitychange");
        app.document.visibilityState = "visible";
        app.dispatch("visibilitychange");
      } else {
        app.dispatchWindow("pageshow", { persisted: true });
      }

      assert.equal(app.document.body.style.opacity, "");
      await settle();
      assert.equal(app.requests.length, 1);
      assert.equal(app.requests[0].headers["X-User-Activity"], undefined);
    });
  }
});


test("repeated hide reapplies a cover cleared by a Turbo morph", async () => {
  const app = setup();
  app.dispatchWindow("pagehide");
  assert.equal(app.document.body.style.opacity, "0");
  app.document.body.style.opacity = "";
  delete app.document.body.dataset.sessionPrivacyOpacity;
  app.document.visibilityState = "hidden";
  app.dispatch("visibilitychange");
  assert.equal(app.document.body.style.opacity, "0");
  app.document.visibilityState = "visible";
  app.dispatch("visibilitychange");
  assert.equal(app.document.body.style.opacity, "");
  await settle();
});


test("browser find and focus changes never cover a visible page", async (t) => {
  for (const preference of [false, true]) {
    await t.test(`background privacy ${preference}`, async () => {
      const app = setup(1, preference);
      app.dispatch("keydown", { isTrusted: true, metaKey: true, key: "f" });
      app.dispatchWindow("blur");
      assert.equal(app.document.body.style.opacity, "");
      assert.equal(app.controller.backgrounded, false);
      app.dispatchWindow("focus");
      await settle();
      assert.equal(app.document.body.style.opacity, "");
    });
  }
});

test("background privacy off keeps content visible and still enforces expiration on resume", async (t) => {
  for (const leave of ["visibilitychange", "pagehide"]) {
    await t.test(leave, async () => {
      const app = setup(1, false);
      if (leave === "visibilitychange") {
        app.document.visibilityState = "hidden";
        app.dispatch(leave);
      } else {
        app.dispatchWindow(leave);
      }
      assert.equal(app.document.body.style.opacity, "");
      app.advanceWallClock(120_000);
      let respond;
      app.context.fetch = () => new Promise((resolve) => { respond = resolve; });
      app.document.visibilityState = "visible";
      app.dispatchWindow("pageshow");
      assert.equal(app.document.body.style.opacity, "0");
      respond({ status: 401 });
      await settle();
      assert.deepEqual(app.redirects, [app.controller.expiredUrlValue]);
    });
  }
});

test("background privacy off still covers an expired foreground session", async () => {
  const app = setup(1, false);
  app.context.fetch = async () => ({ status: 401 });
  app.advance(60_000);
  app.runTimers();
  assert.equal(app.document.body.style.opacity, "0");
  await settle();
  assert.deepEqual(app.redirects, [app.controller.expiredUrlValue]);
});


test("background privacy off resumes a valid session without covering or renewing it", async () => {
  const app = setup(1, false);
  app.document.visibilityState = "hidden";
  app.dispatch("visibilitychange");
  app.document.visibilityState = "visible";
  app.dispatch("visibilitychange");
  assert.equal(app.document.body.style.opacity, "");
  await settle();
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].headers["X-User-Activity"], undefined);
});

test("changing background privacy while hidden updates the cover without bypassing expiration", () => {
  const app = setup(1, false);
  app.document.visibilityState = "hidden";
  app.dispatch("visibilitychange");
  app.controller.hideInBackgroundValueChanged(true);
  assert.equal(app.document.body.style.opacity, "0");
  app.controller.hideInBackgroundValueChanged(false);
  assert.equal(app.document.body.style.opacity, "");
  app.controller.hideInBackgroundValueChanged(true);
  app.advance(60_000);
  app.controller.hideInBackgroundValueChanged(false);
  assert.equal(app.document.body.style.opacity, "0");
});
