# Browser session timeouts

Self-hosted super admins can configure **Inactivity timeout** and **Absolute
session timeout** in Settings → Self-Hosting → Session Security. Both default to
Unlimited to preserve Sure's existing permanent-cookie login behavior.

The inactivity limit expires a browser session after the configured number of
minutes without user interaction. Keyboard, pointer, touch, form interaction,
and full-page navigation count as activity. Background polling and Turbo frame
requests do not. The absolute limit starts at the original successful login and
never moves when the user is active. When both limits are enabled, the first
deadline reached expires the session.

Values are whole minutes. Custom values must be from 1 through 525,600 minutes
(one year). For example, an administrator could choose an inactivity timeout of
15 minutes and an absolute timeout of 24 hours; this is an example, not Sure's
default.

Changes take effect immediately on the next authenticated browser request,
including for existing sessions. A session already past a newly configured
deadline is revoked server-side and cannot become valid again if the setting is
later increased or disabled. Expiry deletes the database session and the signed
browser cookie. The permanent cookie therefore does not extend access beyond
the server-side deadline.

These settings cover interactive browser-cookie sessions, including the
browser-cookie checks used by OAuth authorization and Doorkeeper administration
and the super-admin route constraint used by Sidekiq. They do not change OAuth
access or refresh token lifetimes, native mobile authentication, API keys, or
MCP credentials. This feature does not sign users out of those clients.
