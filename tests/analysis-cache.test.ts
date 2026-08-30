import {
  describe,
  expect,
  it,
} from "vitest";

import {
  createAnalysisCacheKey,
  LruTtlCache,
} from "@/lib/analysis-cache";

describe("analysis cache", () => {
  it("returns a cached value", () => {
    const cache =
      new LruTtlCache<string>({
        maxEntries: 2,
        ttlMs: 1_000,
      });

    cache.set("issue", "value");

    expect(
      cache.get("issue"),
    ).toBe("value");
  });

  it("expires entries after TTL", () => {
    let now = 1_000;

    const cache =
      new LruTtlCache<string>({
        maxEntries: 2,
        ttlMs: 500,
        now: () => now,
      });

    cache.set(
      "issue",
      "value",
    );

    now = 1_499;

    expect(
      cache.get("issue"),
    ).toBe("value");

    now = 1_500;

    expect(
      cache.get("issue"),
    ).toBeUndefined();

    expect(cache.size).toBe(0);
  });

  it("evicts the least recently used entry", () => {
    const cache =
      new LruTtlCache<string>({
        maxEntries: 2,
        ttlMs: 10_000,
      });

    cache.set("first", "1");
    cache.set("second", "2");

    expect(
      cache.get("first"),
    ).toBe("1");

    cache.set("third", "3");

    expect(
      cache.get("first"),
    ).toBe("1");

    expect(
      cache.get("second"),
    ).toBeUndefined();

    expect(
      cache.get("third"),
    ).toBe("3");
  });

  it("never grows beyond its configured bound", () => {
    const cache =
      new LruTtlCache<number>({
        maxEntries: 3,
        ttlMs: 10_000,
      });

    for (
      let index = 0;
      index < 100;
      index++
    ) {
      cache.set(
        `key-${index}`,
        index,
      );
    }

    expect(cache.size).toBe(3);

    expect(
      cache.get("key-97"),
    ).toBe(97);

    expect(
      cache.get("key-98"),
    ).toBe(98);

    expect(
      cache.get("key-99"),
    ).toBe(99);
  });

  it("uses issue content rather than database issue ID", () => {
    const first =
      createAnalysisCacheKey({
        title:
          "Application crashes",
        body:
          "Crash occurs during startup.",
      });

    const second =
      createAnalysisCacheKey({
        title:
          "Application crashes",
        body:
          "Crash occurs during startup.",
      });

    expect(first).toBe(second);
  });

  it("invalidates the key when the issue title changes", () => {
    const before =
      createAnalysisCacheKey({
        title: "Old title",
        body: "Same body",
      });

    const after =
      createAnalysisCacheKey({
        title: "New title",
        body: "Same body",
      });

    expect(after).not.toBe(
      before,
    );
  });

  it("invalidates the key when the issue body changes", () => {
    const before =
      createAnalysisCacheKey({
        title: "Same title",
        body: "Old body",
      });

    const after =
      createAnalysisCacheKey({
        title: "Same title",
        body: "New body",
      });

    expect(after).not.toBe(
      before,
    );
  });
});