import * as Sentry from "@sentry/nextjs";

type LogContextValue =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined;

type LogContext = Record<
  string,
  LogContextValue
>;

function normalizeForJson(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: normalizeForJson(
        value.cause,
        seen,
      ),
    };
  }

  if (
    value === null ||
    typeof value !== "object"
  ) {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) =>
      normalizeForJson(item, seen),
    );
  }

  return Object.fromEntries(
    Object.entries(value).map(
      ([key, nestedValue]) => [
        key,
        normalizeForJson(
          nestedValue,
          seen,
        ),
      ],
    ),
  );
}

function normalizeContext(
  context: LogContext,
) {
  return Object.fromEntries(
    Object.entries(context)
      .filter(
        ([, value]) =>
          value !== undefined,
      )
      .map(([key, value]) => [
        key,
        typeof value === "bigint"
          ? value.toString()
          : value,
      ]),
  );
}

function normalizeError(
  error: unknown,
) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: normalizeForJson(
        error.cause,
      ),
    };
  }

  return {
    name: "UnknownError",
    message:
      typeof error === "string"
        ? error
        : "Non-Error value thrown",
    value: normalizeForJson(error),
  };
}

export function logUnexpectedError({
  operation,
  error,
  context = {},
}: {
  operation: string;
  error: unknown;
  context?: LogContext;
}) {
  const safeContext =
    normalizeContext(context);

  let sentryEventId:
    | string
    | null = null;

  if (process.env.SENTRY_DSN) {
    Sentry.withScope((scope) => {
      scope.setTag(
        "operation",
        operation,
      );

      scope.setContext(
        "operation_context",
        safeContext,
      );

      sentryEventId =
        Sentry.captureException(
          error,
        );
    });
  }

  console.error(
    JSON.stringify({
      timestamp:
        new Date().toISOString(),
      level: "error",
      operation,
      sentryEventId,
      context: safeContext,
      error: normalizeError(error),
    }),
  );

  return sentryEventId;
}