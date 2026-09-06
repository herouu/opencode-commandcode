import { expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { writeCatalogCache, type ModelEntry } from "../../src/startup.ts";

type PluginResult = {
  config: (config: Record<string, unknown>) => Promise<void>;
  auth: {
    provider: string;
    methods: Array<{
      type: string;
      label: string;
    }>;
    loader: (
      getAuth: () => Promise<{ type: string; key?: string } | null>,
    ) => Promise<Record<string, unknown>>;
  };
};

type PluginModule = { default: () => Promise<PluginResult> };

let pluginFn: PluginModule["default"];
let testStateDir: string;
let prevStateDir: string | undefined;
let prevCatalogUrl: string | undefined;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const modelsPath = join(repoRoot, "models.json");
const modelsBackup = join(repoRoot, "models.json.test-bak");

const cacheSample: ModelEntry[] = [
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

function hideBundledCatalog(): void {
  if (existsSync(modelsPath)) renameSync(modelsPath, modelsBackup);
}

function restoreBundledCatalog(): void {
  if (existsSync(modelsBackup)) renameSync(modelsBackup, modelsPath);
}

beforeAll(async () => {
  testStateDir = mkdtempSync(join(tmpdir(), "cc-plugin-state-"));
  prevStateDir = process.env.COMMANDCODE_PROVIDER_STATE_DIR;
  process.env.COMMANDCODE_PROVIDER_STATE_DIR = testStateDir;
  // These tests exercise the bundled/cache fallback path (models.json missing or
  // corrupted). Disable the runtime remote fetch so a live network (CI) cannot
  // supply a "remote" catalog and change which source is under test.
  prevCatalogUrl = process.env.COMMANDCODE_CATALOG_URL;
  process.env.COMMANDCODE_CATALOG_URL = "disabled";
  const mod = await import("../../plugin.ts");
  pluginFn = mod.default;
});

afterAll(() => {
  if (prevStateDir === undefined) delete process.env.COMMANDCODE_PROVIDER_STATE_DIR;
  else process.env.COMMANDCODE_PROVIDER_STATE_DIR = prevStateDir;
  if (prevCatalogUrl === undefined) delete process.env.COMMANDCODE_CATALOG_URL;
  else process.env.COMMANDCODE_CATALOG_URL = prevCatalogUrl;
  rmSync(testStateDir, { recursive: true, force: true });
  restoreBundledCatalog();
});

test("plugin returns correct provider name", async () => {
  const plugin = await pluginFn();
  expect(plugin.auth.provider).toBe("commandcode");
});

test("loader returns apiKey on successful auth", async () => {
  const plugin = await pluginFn();
  const result = await plugin.auth.loader(async () => ({
    type: "api",
    key: "sk-loaded-key",
  }));
  expect(result).toEqual({ apiKey: "sk-loaded-key" });
});

test("loader returns empty object on null auth", async () => {
  const plugin = await pluginFn();
  const result = await plugin.auth.loader(async () => null);
  expect(result).toEqual({});
});

test("loader returns empty object on wrong auth type", async () => {
  const plugin = await pluginFn();
  const result = await plugin.auth.loader(
    async () =>
      ({
        type: "oauth",
        key: "some-token",
      }) as Record<string, unknown>,
  );
  expect(result).toEqual({});
});

test("loader returns empty object when getAuth throws", async () => {
  const plugin = await pluginFn();
  const result = await plugin.auth.loader(async () => {
    throw new Error("auth failed");
  });
  expect(result).toEqual({});
});

test("config hook registers provider with npm and models", async () => {
  const plugin = await pluginFn();
  const config: Record<string, unknown> = {
    provider: { commandcode: {} },
  };
  await plugin.config(config);

  const cc = (config.provider as Record<string, Record<string, unknown>>).commandcode;
  expect(cc.npm).toBe("@ai-sdk/openai-compatible");
  expect(cc.name).toBe("Command Code");
  expect(cc.env).toEqual(["COMMANDCODE_API_KEY"]);
  expect(cc.models).toBeDefined();
  const models = cc.models as Record<string, unknown>;
  expect(Object.keys(models).length).toBeGreaterThan(0);
});

test("config hook does not overwrite existing npm field", async () => {
  const plugin = await pluginFn();
  const config: Record<string, unknown> = {
    provider: { commandcode: { npm: "custom-package" } },
  };
  await plugin.config(config);

  const cc = (config.provider as Record<string, Record<string, unknown>>).commandcode;
  expect(cc.npm).toBe("custom-package");
});

test("config hook injects default baseURL when options missing", async () => {
  const plugin = await pluginFn();
  const config: Record<string, unknown> = {
    provider: { commandcode: {} },
  };
  await plugin.config(config);

  const cc = (config.provider as Record<string, Record<string, unknown>>).commandcode;
  const options = cc.options as Record<string, unknown>;
  expect(options).toBeDefined();
  expect(options.baseURL).toBe("https://api.commandcode.ai/provider/v1/");
});

test("config hook does not overwrite existing baseURL", async () => {
  const plugin = await pluginFn();
  const config: Record<string, unknown> = {
    provider: { commandcode: { options: { baseURL: "https://custom.example.com" } } },
  };
  await plugin.config(config);

  const cc = (config.provider as Record<string, Record<string, unknown>>).commandcode;
  const options = cc.options as Record<string, unknown>;
  expect(options.baseURL).toBe("https://custom.example.com");
});

test("config hook does not overwrite existing models", async () => {
  const plugin = await pluginFn();
  const config: Record<string, unknown> = {
    provider: { commandcode: { models: { "my-model": { id: "my-model" } } } },
  };
  await plugin.config(config);

  const cc = (config.provider as Record<string, Record<string, unknown>>).commandcode;
  const models = cc.models as Record<string, unknown>;
  expect(Object.keys(models)).toEqual(["my-model"]);
});

test("config hook creates provider block if missing", async () => {
  const plugin = await pluginFn();
  const config: Record<string, unknown> = {};
  await plugin.config(config);

  expect(config.provider).toBeDefined();
  const cc = (config.provider as Record<string, Record<string, unknown>>).commandcode;
  expect(cc).toBeDefined();
  expect(cc.npm).toBe("@ai-sdk/openai-compatible");
});

test("config hook creates commandcode block when provider exists but empty", async () => {
  const plugin = await pluginFn();
  const config: Record<string, unknown> = { provider: {} };
  await plugin.config(config);

  const cc = (config.provider as Record<string, Record<string, unknown>>).commandcode;
  expect(cc).toBeDefined();
  expect(cc.npm).toBe("@ai-sdk/openai-compatible");
  expect(Object.keys((cc.models as object) ?? {}).length).toBeGreaterThan(0);
});

test("startup summary uses bundled manifest version and status", async () => {
  const plugin = await pluginFn();
  const config: Record<string, unknown> = { provider: { commandcode: {} } };
  await plugin.config(config);
  const summary = JSON.parse(readFileSync(join(testStateDir, "startup.json"), "utf-8"));
  const manifest = JSON.parse(readFileSync(join(repoRoot, "manifest.json"), "utf-8")) as {
    status: string;
    commandCodeVersion: string;
  };
  expect(summary.catalogSource).toBe("bundled");
  expect(summary.commandCodeVersion).toBe(manifest.commandCodeVersion);
  expect(summary.commandCodeVersion).toMatch(/^\d+\.\d+\.\d+/);
  expect(summary.degraded).toBe(manifest.status === "degraded" || manifest.status === "broken");
  expect(summary.modelCount).toBeGreaterThan(20);
});

test("config does not write to stdout or stderr by default", async () => {
  const logs: unknown[][] = [];
  const warns: unknown[][] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };
  console.warn = (...args: unknown[]) => {
    warns.push(args);
  };
  try {
    const plugin = await pluginFn();
    const config: Record<string, unknown> = { provider: { commandcode: {} } };
    await plugin.config(config);
    expect(logs).toEqual([]);
    expect(warns).toEqual([]);
    const cc = (config.provider as Record<string, Record<string, unknown>>).commandcode;
    expect(cc.models).toBeDefined();
    expect(Object.keys(cc.models as object).length).toBeGreaterThan(0);
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
});

test("config hook attaches reasoning effort variants when available", async () => {
  const plugin = await pluginFn();
  const config: Record<string, unknown> = {
    provider: { commandcode: {} },
  };
  await plugin.config(config);

  const cc = (config.provider as Record<string, Record<string, unknown>>).commandcode;
  const models = cc.models as Record<string, Record<string, unknown>>;
  const withVariants = Object.values(models).filter(
    (m) => m.variants && typeof m.variants === "object",
  );
  // Bundled models.json or local command-code should expose at least one effort list
  expect(withVariants.length).toBeGreaterThan(0);
  const sample = withVariants[0];
  const variants = sample.variants as Record<string, { reasoningEffort?: string }>;
  const keys = Object.keys(variants);
  expect(keys.length).toBeGreaterThan(0);
  expect(variants[keys[0]].reasoningEffort).toBe(keys[0]);
});

test("CA-04: registers npm/env with empty models when bundled and cache miss", async () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "cc-ca04-"));
  const prev = process.env.COMMANDCODE_PROVIDER_STATE_DIR;
  process.env.COMMANDCODE_PROVIDER_STATE_DIR = emptyDir;
  hideBundledCatalog();
  try {
    const plugin = await pluginFn();
    const config: Record<string, unknown> = { provider: { commandcode: {} } };
    await plugin.config(config);

    const cc = (config.provider as Record<string, Record<string, unknown>>).commandcode;
    expect(cc.npm).toBe("@ai-sdk/openai-compatible");
    expect(cc.name).toBe("Command Code");
    expect(cc.env).toEqual(["COMMANDCODE_API_KEY"]);
    expect(cc.models).toEqual({});

    const summary = JSON.parse(readFileSync(join(emptyDir, "startup.json"), "utf-8"));
    expect(summary.degraded).toBe(true);
    expect(summary.modelCount).toBe(0);
  } finally {
    restoreBundledCatalog();
    if (prev === undefined) delete process.env.COMMANDCODE_PROVIDER_STATE_DIR;
    else process.env.COMMANDCODE_PROVIDER_STATE_DIR = prev;
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("CA-05: falls back to last-good cache when bundled catalog unreadable", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "cc-ca05-"));
  writeCatalogCache(cacheDir, cacheSample);
  const prev = process.env.COMMANDCODE_PROVIDER_STATE_DIR;
  process.env.COMMANDCODE_PROVIDER_STATE_DIR = cacheDir;
  hideBundledCatalog();
  try {
    const plugin = await pluginFn();
    const config: Record<string, unknown> = { provider: { commandcode: {} } };
    await plugin.config(config);

    const cc = (config.provider as Record<string, Record<string, unknown>>).commandcode;
    expect(Object.keys(cc.models as object).length).toBeGreaterThan(0);

    const summary = JSON.parse(readFileSync(join(cacheDir, "startup.json"), "utf-8"));
    expect(summary.catalogSource).toBe("cache");
    expect(summary.degraded).toBe(true);
    expect(summary.degradedReason).toContain("last-good cache");
    expect(summary.modelCount).toBe(1);
  } finally {
    restoreBundledCatalog();
    if (prev === undefined) delete process.env.COMMANDCODE_PROVIDER_STATE_DIR;
    else process.env.COMMANDCODE_PROVIDER_STATE_DIR = prev;
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
