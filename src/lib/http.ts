export function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function retryDelayMs(attempt: number, baseDelayMs: number) {
  return baseDelayMs * 2 ** (attempt - 1);
}

export function isRetryableHttpStatus(status: number) {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = 10_000
) {
  const timeoutController = new AbortController();

  const timeout = setTimeout(() => {
    timeoutController.abort(
      new DOMException("Request timed out.", "TimeoutError")
    );
  }, timeoutMs);

  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    return await fetch(input, {
      ...init,
      signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}