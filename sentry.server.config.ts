import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn:
    process.env.SENTRY_DSN,
  enabled:
    Boolean(
      process.env.SENTRY_DSN,
    ),
  sendDefaultPii: false,
  tracesSampleRate:
    process.env.NODE_ENV ===
    "production"
      ? 0.1
      : 0,
});