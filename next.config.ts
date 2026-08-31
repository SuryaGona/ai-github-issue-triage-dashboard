import {
  withSentryConfig,
} from "@sentry/nextjs";
import type {
  NextConfig,
} from "next";

const nextConfig: NextConfig = {};

export default withSentryConfig(
  nextConfig,
  {
    silent: true,
    authToken:
      process.env.SENTRY_AUTH_TOKEN,
    org:
      process.env.SENTRY_ORG,
    project:
      process.env.SENTRY_PROJECT,
  },
);