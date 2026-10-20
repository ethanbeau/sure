import { Controller } from "@hotwired/stimulus";

const ACTIVITY_THROTTLE_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const REQUEST_TIMEOUT_MS = 10_000;

export default class extends Controller {
  static values = {
    url: String,
    deadlines: String,
    expiredUrl: String,
    hideInBackground: { type: Boolean, default: false },
  };

  connect() {
    this.connected = true;
    this.lastSentAt = Number.NEGATIVE_INFINITY;
    this.timeoutTimer = null;
    this.activityTimer = null;
    this.activityPending = false;
    this.backgrounded = document.visibilityState === "hidden";
    this.resumeValidationRequired = false;
    this.pendingRequest = null;
    if (this.deadlinesValue) {
      this.applyDeadlines(JSON.parse(this.deadlinesValue));
    } else {
      // A restored snapshot must revalidate before displaying private content.
      this.deadlineAt = performance.now();
      this.wallClockDeadlineAt = Date.now();
      this.checkDeadline();
    }
    if (this.backgrounded) {
      this.coverForResume();
    } else if (this.deadlinesValue && this.isLocallyUnexpired()) {
      this.restoreVisibility();
    }
  }

  disconnect() {
    if (this.activityPending) {
      this.cancelRequest();
      this.requestDeadlines({ activity: true });
    }
    this.connected = false;
    window.clearTimeout(this.timeoutTimer);
    this.clearActivity();
    // Let the keepalive heartbeat finish; detached responses cannot change UI.
    this.cancelRequest({ preserveActivity: true });
    this.restoreVisibility();
  }

  deadlinesValueChanged(value) {
    if (!this.connected || !value) return;

    this.applyDeadlines(JSON.parse(value));
  }

  beforeCache() {
    // Turbo clones these values into its snapshot. Never reuse its server clock.
    this.deadlinesValue = "";
  }

  handleVisibilityChange() {
    if (document.visibilityState === "hidden") {
      this.coverForResume();
    } else {
      this.resumeFromBackground();
    }
  }

  resumeFromBackground() {
    if (!this.connected || document.visibilityState === "hidden") return;

    if (this.backgrounded) this.cancelRequest();
    this.backgrounded = false;
    if (this.isLocallyUnexpired()) {
      // Returning before the known deadline must not depend on a network
      // round-trip to uncover the page. Still check for server-side revocation.
      this.resumeValidationRequired = false;
      this.restoreVisibility();
      this.scheduleDeadlineCheck();
      if (!this.pendingRequest) this.requestDeadlines();
      return;
    }
    this.checkDeadline();
  }

  coverForResume() {
    if (!this.connected) return;

    const wasBackgrounded = this.backgrounded;
    this.backgrounded = true;
    this.resumeValidationRequired = true;
    // Safari can suspend fetches and their timeout callbacks in the background.
    // Start a fresh check on return instead of waiting for a suspended request.
    if (!wasBackgrounded) {
      this.cancelRequest();
      // Flush real interactions before suspension instead of losing a throttled
      // final click or letting a background timer extend the idle period later.
      if (this.activityPending) this.requestDeadlines({ activity: true });
    }
    if (this.hideInBackgroundValue) this.coverContent();
  }

  hideInBackgroundValueChanged(value) {
    if (!this.connected || !this.backgrounded) return;

    if (value) {
      this.coverContent();
    } else if (this.isLocallyUnexpired()) {
      this.restoreVisibility();
    }
  }

  coverContent() {
    // Reapply on every hide: Turbo morphs can replace inline styles while the
    // controller instance and its privacyScreenActive flag remain alive.
    // Opacity preserves hit testing without creating a page-sized blur layer.
    // Store the previous value in the DOM so Turbo snapshots can restore it too.
    this.privacyElements().forEach((element) => {
      if (!("sessionPrivacyOpacity" in element.dataset)) {
        element.dataset.sessionPrivacyOpacity = element.style.opacity;
      }
      element.style.opacity = "0";
    });
    this.privacyScreenActive = true;
    // Pending Turbo responses can add top-layer content after the page hides.
    // Mutation observers run before paint, including after showModal().
    if (!this.privacyObserver) {
      this.privacyObserver = new MutationObserver(() => {
        if (this.privacyScreenActive) this.coverContent();
      });
      this.privacyObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["popover"],
      });
    }
  }

  recordActivity(event) {
    if (
      !this.connected ||
      !event.isTrusted ||
      document.visibilityState === "hidden"
    )
      return;
    // A real touch is also a resume signal if Safari omitted focus/pageshow.
    // Validate without renewing the session when returning from the background.
    if (this.privacyScreenActive || this.backgrounded) {
      this.resumeFromBackground();
      return;
    }
    this.activityPending = true;
    this.scheduleActivity();
  }

  scheduleActivity() {
    window.clearTimeout(this.activityTimer);
    if (
      !this.connected ||
      !this.activityPending ||
      this.pendingRequest ||
      this.backgrounded ||
      this.privacyScreenActive ||
      document.visibilityState === "hidden"
    )
      return;

    const delay =
      this.activityThrottleMs - (performance.now() - this.lastSentAt);
    if (delay > 0) {
      this.activityTimer = window.setTimeout(
        () => this.scheduleActivity(),
        delay,
      );
      return;
    }

    this.requestDeadlines({ activity: true });
  }

  clearActivity() {
    window.clearTimeout(this.activityTimer);
    this.activityPending = false;
  }

  async requestDeadlines({ activity = false } = {}) {
    const csrfToken = document.querySelector(
      'meta[name="csrf-token"]',
    )?.content;
    if (!csrfToken) {
      if (this.privacyScreenActive && !this.backgrounded)
        window.location.reload();
      return;
    }

    const request = {
      controller: new AbortController(),
      activity,
      startedAt: performance.now(),
      wallClockStartedAt: Date.now(),
    };
    request.timer = window.setTimeout(
      () => request.controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    this.pendingRequest = request;
    if (activity) {
      this.clearActivity();
      this.lastSentAt = request.startedAt;
    }

    try {
      const headers = { "X-CSRF-Token": csrfToken, Accept: "application/json" };
      if (activity) headers["X-User-Activity"] = "true";
      const response = await fetch(this.urlValue, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers,
        keepalive: activity,
        signal: request.controller.signal,
      });
      if (this.pendingRequest !== request) return;
      if (response.status === 401) {
        this.clearActivity();
        this.coverContent();
        window.location.replace(this.expiredUrlValue);
        return;
      }
      if (!response.ok) throw new Error("Session check failed");

      const deadlines = await response.json();
      if (this.pendingRequest !== request) return;
      this.applyDeadlines(deadlines, request);
      this.resumeValidationRequired = false;
      if (
        !this.backgrounded &&
        document.visibilityState !== "hidden" &&
        this.isLocallyUnexpired()
      ) {
        this.restoreVisibility();
      }
    } catch {
      if (this.pendingRequest !== request) return;
      if (this.privacyScreenActive && !this.backgrounded)
        window.location.reload();
    } finally {
      window.clearTimeout(request.timer);
      if (this.pendingRequest === request) {
        this.pendingRequest = null;
        this.scheduleActivity();
      }
    }
  }

  cancelRequest({ preserveActivity = false } = {}) {
    const request = this.pendingRequest;
    this.pendingRequest = null;
    if (!request) return;

    window.clearTimeout(request.timer);
    if (!preserveActivity || !request.activity) request.controller.abort();
  }

  pageRequestTiming() {
    // Turbo visits use fetch; a hard navigation has its own timing entry.
    // Starting the clock before the server sample is conservative and also
    // accounts for prefetched HTML waiting before it is displayed.
    const url = window.location.href.split("#")[0];
    const entries = [
      ...performance.getEntriesByType("navigation"),
      ...performance
        .getEntriesByName(url, "resource")
        .filter((entry) => entry.initiatorType === "fetch"),
    ];
    const startedAt = Math.max(0, ...entries.map((entry) => entry.startTime));
    return {
      startedAt,
      wallClockStartedAt: performance.timeOrigin + startedAt,
    };
  }

  applyDeadlines(deadlines, timing = this.pageRequestTiming()) {
    const serverNow = Date.parse(deadlines.server_now);
    if (!Number.isFinite(serverNow))
      throw new Error("Invalid session deadlines");

    const inactivityDeadline = Date.parse(deadlines.inactivity_deadline);
    const absoluteDeadline = Date.parse(deadlines.absolute_deadline);
    // Leave time for a renewal even with the shortest supported idle timeout.
    this.activityThrottleMs = Number.isFinite(inactivityDeadline)
      ? Math.min(
          ACTIVITY_THROTTLE_MS,
          Math.max(0, (inactivityDeadline - serverNow) / 2),
        )
      : ACTIVITY_THROTTLE_MS;

    const deadlinesAt = [inactivityDeadline, absoluteDeadline].filter(
      Number.isFinite,
    );
    if (deadlinesAt.length === 0) {
      this.deadlineAt = null;
      this.wallClockDeadlineAt = null;
      window.clearTimeout(this.timeoutTimer);
      return;
    }

    const remaining = Math.min(...deadlinesAt) - serverNow;
    this.deadlineAt = timing.startedAt + remaining;
    this.wallClockDeadlineAt = timing.wallClockStartedAt + remaining;
    this.scheduleDeadlineCheck();
    if (!this.isLocallyUnexpired()) this.coverContent();
    this.scheduleActivity();
  }

  isLocallyUnexpired() {
    return this.deadlineAt === null || this.remainingDeadlineMs() > 0;
  }

  remainingDeadlineMs() {
    // Some platforms pause performance.now() during sleep. Either clock can
    // trigger revalidation; a wall-clock rollback must not extend the session.
    return Math.min(
      this.deadlineAt - performance.now(),
      this.wallClockDeadlineAt - Date.now(),
    );
  }

  scheduleDeadlineCheck() {
    window.clearTimeout(this.timeoutTimer);
    if (this.deadlineAt === null) return;

    const remaining = this.remainingDeadlineMs();
    this.timeoutTimer = window.setTimeout(
      () => this.checkDeadline(),
      Math.max(0, Math.min(remaining, MAX_TIMER_DELAY_MS)),
    );
  }

  checkDeadline() {
    if (!this.connected || this.backgrounded) return;
    if (this.resumeValidationRequired) {
      this.coverContent();
      if (!this.pendingRequest) this.requestDeadlines();
      return;
    }
    if (this.deadlineAt === null) return;
    if (this.privacyScreenActive && this.pendingRequest) return;
    if (this.remainingDeadlineMs() > 0) {
      this.scheduleDeadlineCheck();
      return;
    }

    this.coverContent();

    // A stalled renewal must not delay hiding the page at its deadline.
    const activity = this.activityPending;
    this.clearActivity();
    this.cancelRequest();
    return this.requestDeadlines({ activity });
  }

  restoreVisibility() {
    this.privacyObserver?.disconnect();
    this.privacyObserver = null;
    // Do not rely on controller state: a restored snapshot may already carry
    // the cover from an earlier controller instance.
    this.privacyElements().forEach((element) => {
      if (!("sessionPrivacyOpacity" in element.dataset)) return;
      element.style.opacity = element.dataset.sessionPrivacyOpacity;
      delete element.dataset.sessionPrivacyOpacity;
    });
    this.privacyScreenActive = false;
  }

  privacyElements() {
    // The controller can be mounted on a small element within the page.
    // Cover the body and top-layer content wherever it appears in the page.
    return [
      document.body,
      ...document.body.querySelectorAll("dialog, [popover]"),
    ];
  }
}
