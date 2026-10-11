import { Controller } from "@hotwired/stimulus";

const ACTIVITY_THROTTLE_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const RETRY_DELAY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;

export default class extends Controller {
  static values = {
    url: String,
    deadlines: String,
    expiredUrl: String,
  };

  connect() {
    this.connected = true;
    this.lastSentAt = Number.NEGATIVE_INFINITY;
    this.timeoutTimer = null;
    this.pendingRequest = null;
    this.recordActivity = this.recordActivity.bind(this);
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
    this.handlePageHide = this.handlePageHide.bind(this);
    this.handlePageShow = this.handlePageShow.bind(this);
    this.handleWindowBlur = this.handleWindowBlur.bind(this);
    this.handleWindowFocus = this.handleWindowFocus.bind(this);
    this.activityEvents = [
      "pointerdown",
      "click",
      "keydown",
      "touchstart",
      "wheel",
      "input",
      "change",
    ];
    this.activityEvents.forEach((event) =>
      document.addEventListener(event, this.recordActivity, {
        passive: true,
        capture: true,
      }),
    );
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    window.addEventListener("pagehide", this.handlePageHide);
    window.addEventListener("pageshow", this.handlePageShow);
    window.addEventListener("blur", this.handleWindowBlur);
    window.addEventListener("focus", this.handleWindowFocus);
    if (this.deadlinesValue) {
      this.applyDeadlines(JSON.parse(this.deadlinesValue));
    } else {
      // A restored snapshot must revalidate before displaying private content.
      this.deadlineAt = performance.now();
      this.wallClockDeadlineAt = Date.now();
      this.checkDeadline();
    }
  }

  disconnect() {
    this.connected = false;
    window.clearTimeout(this.timeoutTimer);
    this.cancelRequest();
    this.restoreVisibility();
    this.activityEvents.forEach((event) =>
      document.removeEventListener(event, this.recordActivity, true),
    );
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    window.removeEventListener("pagehide", this.handlePageHide);
    window.removeEventListener("pageshow", this.handlePageShow);
    window.removeEventListener("blur", this.handleWindowBlur);
    window.removeEventListener("focus", this.handleWindowFocus);
  }

  beforeCache() {
    // Turbo clones these values into its snapshot. Never reuse its server clock.
    this.deadlinesValue = "";
  }

  handleVisibilityChange() {
    if (document.visibilityState === "hidden") {
      this.coverForResume();
    } else {
      this.checkDeadline();
    }
  }

  handlePageHide() {
    this.coverForResume();
  }

  handlePageShow() {
    this.checkDeadline();
  }

  handleWindowBlur() {
    this.coverForResume();
  }

  handleWindowFocus() {
    this.checkDeadline();
  }

  coverForResume() {
    if (!this.connected) return;

    this.resumeValidationRequired = true;
    this.coverContent();
  }

  coverContent() {
    if (this.privacyScreenActive) return;

    this.originalVisibility = document.documentElement.style.visibility;
    document.documentElement.style.visibility = "hidden";
    this.privacyScreenActive = true;
  }

  recordActivity(event) {
    if (
      !this.connected ||
      !event.isTrusted ||
      document.visibilityState === "hidden" ||
      this.privacyScreenActive ||
      this.pendingRequest
    )
      return;
    if (performance.now() - this.lastSentAt < this.activityThrottleMs) return;

    this.requestDeadlines({ activity: true });
  }

  async requestDeadlines({ activity = false } = {}) {
    const csrfToken = document.querySelector(
      'meta[name="csrf-token"]',
    )?.content;
    if (!csrfToken) {
      if (this.privacyScreenActive) this.retryDeadlineCheck();
      return;
    }

    const request = { controller: new AbortController() };
    request.timer = window.setTimeout(
      () => request.controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    this.pendingRequest = request;
    if (activity) this.lastSentAt = performance.now();

    try {
      const headers = { "X-CSRF-Token": csrfToken, Accept: "application/json" };
      if (activity) headers["X-User-Activity"] = "true";
      const response = await fetch(this.urlValue, {
        method: "POST",
        credentials: "same-origin",
        headers,
        keepalive: activity,
        signal: request.controller.signal,
      });
      if (this.pendingRequest !== request) return;
      if (response.status === 401) {
        window.location.replace(this.expiredUrlValue);
        return;
      }
      if (!response.ok) throw new Error("Session check failed");

      const deadlines = await response.json();
      if (this.pendingRequest !== request) return;
      this.applyDeadlines(deadlines);
      this.resumeValidationRequired = false;
      this.restoreVisibility();
    } catch {
      if (this.pendingRequest !== request) return;
      if (this.privacyScreenActive) this.retryDeadlineCheck();
    } finally {
      window.clearTimeout(request.timer);
      if (this.pendingRequest === request) this.pendingRequest = null;
    }
  }

  cancelRequest() {
    const request = this.pendingRequest;
    this.pendingRequest = null;
    if (!request) return;

    window.clearTimeout(request.timer);
    request.controller.abort();
  }

  applyDeadlines(deadlines) {
    const serverNow = Date.parse(deadlines.server_now);
    if (!Number.isFinite(serverNow)) return;

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
    this.deadlineAt = performance.now() + remaining;
    this.wallClockDeadlineAt = Date.now() + remaining;
    this.scheduleDeadlineCheck();
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
    if (!this.connected) return;
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
    this.cancelRequest();
    return this.requestDeadlines();
  }

  restoreVisibility() {
    if (!this.privacyScreenActive) return;

    document.documentElement.style.visibility = this.originalVisibility;
    this.privacyScreenActive = false;
  }

  retryDeadlineCheck() {
    this.deadlineAt = performance.now() + RETRY_DELAY_MS;
    this.wallClockDeadlineAt = Date.now() + RETRY_DELAY_MS;
    this.scheduleDeadlineCheck();
  }
}
