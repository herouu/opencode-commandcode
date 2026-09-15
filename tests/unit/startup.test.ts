import { expect, test, describe } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  pluginStateDir,
  readCatalogCache,
  readCatalogCacheEntry,
  writeCatalogCache,
  writeStartupSummary,
  type ModelEntry,
} from "../../src/startup.ts";

const sample: ModelEntry[] = [
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    tier: "premium",
    reasoning: true,
    tool_call: true,
    cost: { input: 3, output: 15 },
    limit: { context: 200000, output: 16000 },
  },
];

describe("pluginStateDir", () => {
  test("honors COMMANDCODE_PROVIDER_STATE_DIR when set", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-state-"));
    const prev = process.env.COMMANDCODE_PROVIDER_STATE_DIR;
    process.env.COMMANDCODE_PROVIDER_STATE_DIR = dir;
    try {
      expect(pluginStateDir()).toBe(dir);
    } finally {
      if (prev === undefined) delete process.env.COMMANDCODE_PROVIDER_STATE_DIR;
      else process.env.COMMANDCODE_PROVIDER_STATE_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("catalog cache", () => {
  test("round-trips models and returns null for missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-cache-"));
    try {
      expect(readCatalogCache(dir)).toBeNull();
      writeCatalogCache(dir, sample);
      expect(readCatalogCache(dir)).toEqual(sample);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writes freshness metadata alongside models", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-cache-meta-"));
    try {
      writeCatalogCache(dir, sample, {
        source: "remote",
        generatedAt: "2026-01-02T03:04:05.000Z",
        commandCodeVersion: null,
      });
      const entry = readCatalogCacheEntry(dir);
      expect(entry?.generatedAt).toBe("2026-01-02T03:04:05.000Z");
      expect(entry?.source).toBe("remote");
      expect(entry?.modelCount).toBe(1);
      expect(entry?.models).toEqual(sample);
      // 兼容接口仍返回裸模型数组
      expect(readCatalogCache(dir)).toEqual(sample);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads legacy bare-array cache with unknown freshness", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-cache-legacy-"));
    try {
      writeFileSync(join(dir, "catalog-cache.json"), JSON.stringify(sample), "utf-8");
      const entry = readCatalogCacheEntry(dir);
      expect(entry?.generatedAt).toBeNull();
      expect(entry?.source).toBeNull();
      expect(entry?.modelCount).toBe(1);
      expect(entry?.models).toEqual(sample);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null for malformed cache payloads", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-cache-bad-"));
    try {
      writeFileSync(join(dir, "catalog-cache.json"), "{ not json", "utf-8");
      expect(readCatalogCacheEntry(dir)).toBeNull();
      writeFileSync(join(dir, "catalog-cache.json"), JSON.stringify({ models: [] }), "utf-8");
      expect(readCatalogCacheEntry(dir)).toBeNull();
      writeFileSync(join(dir, "catalog-cache.json"), JSON.stringify([]), "utf-8");
      expect(readCatalogCacheEntry(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("startup summary", () => {
  test("writes startup.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-sum-"));
    try {
      writeStartupSummary(dir, {
        catalogSource: "bundled",
        commandCodeVersion: "1.38.0",
        modelCount: 1,
        reasoningModelCount: 1,
        degraded: false,
        degradedReason: null,
      });
      const parsed = JSON.parse(readFileSync(join(dir, "startup.json"), "utf-8"));
      expect(parsed.catalogSource).toBe("bundled");
      expect(parsed.modelCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
