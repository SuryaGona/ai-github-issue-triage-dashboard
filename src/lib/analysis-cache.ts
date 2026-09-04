import { createHash } from "node:crypto";

export type CachedAnalysis = {
  summary: string;
  category:
    | "Bug"
    | "Feature"
    | "Documentation"
    | "Performance"
    | "Security"
    | "Build"
    | "Other";
  priority: "Critical" | "High" | "Medium" | "Low";
  effort: "Small" | "Medium" | "Large";
  suggestedReply: string;
};

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

type LruTtlCacheOptions = {
  maxEntries: number;
  ttlMs: number;
  now?: () => number;
};

const GEMINI_MODEL = "gemini-3.5-flash";
const ANALYSIS_PROMPT_VERSION = "triage-prompt-v1";
const ANALYSIS_SCHEMA_VERSION = "triage-schema-v1";

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

export class LruTtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor({
    maxEntries,
    ttlMs,
    now = Date.now,
  }: LruTtlCacheOptions) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("maxEntries must be a positive integer.");
    }

    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("ttlMs must be greater than zero.");
    }

    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);

    return entry.value;
  }

  set(key: string, value: T) {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }

    this.entries.set(key, {
      value,
      expiresAt: this.now() + this.ttlMs,
    });

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;

      if (oldestKey === undefined) {
        break;
      }

      this.entries.delete(oldestKey);
    }
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

export function createAnalysisCacheKey(issue: {
  title: string;
  body: string | null;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        model: GEMINI_MODEL,
        promptVersion: ANALYSIS_PROMPT_VERSION,
        schemaVersion: ANALYSIS_SCHEMA_VERSION,
        title: issue.title,
        body: issue.body ?? "",
      }),
    )
    .digest("hex");
}

export const analysisCache = new LruTtlCache<CachedAnalysis>({
  maxEntries: DEFAULT_MAX_ENTRIES,
  ttlMs: DEFAULT_TTL_MS,
});