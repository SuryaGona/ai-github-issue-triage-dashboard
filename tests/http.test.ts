import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  fetchWithTimeout,
  isRetryableHttpStatus,
  retryDelayMs,
} from "@/lib/http";

describe("HTTP resilience helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("classifies only transient HTTP statuses as retryable", () => {
    expect(isRetryableHttpStatus(408)).toBe(true);
    expect(isRetryableHttpStatus(425)).toBe(true);
    expect(isRetryableHttpStatus(429)).toBe(true);
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);

    expect(isRetryableHttpStatus(400)).toBe(false);
    expect(isRetryableHttpStatus(401)).toBe(false);
    expect(isRetryableHttpStatus(403)).toBe(false);
    expect(isRetryableHttpStatus(404)).toBe(false);
  });

  it("calculates exponential retry delays", () => {
    expect(retryDelayMs(1, 500)).toBe(500);
    expect(retryDelayMs(2, 500)).toBe(1_000);
    expect(retryDelayMs(3, 500)).toBe(2_000);

    expect(retryDelayMs(1, 1_000)).toBe(1_000);
    expect(retryDelayMs(2, 1_000)).toBe(2_000);
    expect(retryDelayMs(3, 1_000)).toBe(4_000);
  });

  it("aborts a fetch when its timeout expires", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn(
      (
        _input: string | URL | Request,
        init?: RequestInit
      ) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;

          if (!signal) {
            reject(new Error("Expected an AbortSignal."));
            return;
          }

          if (signal.aborted) {
            reject(signal.reason);
            return;
          }

          signal.addEventListener(
            "abort",
            () => {
              reject(signal.reason);
            },
            { once: true }
          );
        })
    );

    vi.stubGlobal("fetch", fetchMock);

    const requestPromise = fetchWithTimeout(
      "https://example.test/resource",
      {},
      1_000
    );

    const rejectionExpectation = expect(
      requestPromise
    ).rejects.toMatchObject({
      name: "TimeoutError",
      message: "Request timed out.",
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await rejectionExpectation;

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0];

    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(true);
  });

  it("preserves caller cancellation while adding the timeout signal", async () => {
    const callerController = new AbortController();

    const fetchMock = vi.fn(
      (
        _input: string | URL | Request,
        init?: RequestInit
      ) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;

          if (!signal) {
            reject(new Error("Expected an AbortSignal."));
            return;
          }

          if (signal.aborted) {
            reject(signal.reason);
            return;
          }

          signal.addEventListener(
            "abort",
            () => {
              reject(signal.reason);
            },
            { once: true }
          );
        })
    );

    vi.stubGlobal("fetch", fetchMock);

    const requestPromise = fetchWithTimeout(
      "https://example.test/resource",
      {
        signal: callerController.signal,
      },
      10_000
    );

    const rejectionExpectation = expect(
      requestPromise
    ).rejects.toMatchObject({
      name: "AbortError",
      message: "Caller cancelled request.",
    });

    callerController.abort(
      new DOMException(
        "Caller cancelled request.",
        "AbortError"
      )
    );

    await rejectionExpectation;

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0];

    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(true);
  });
});