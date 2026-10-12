import { expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
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

type PluginModule = {
  default: {
    id: string;
    setup: (context: unknown) => Promise<(() => void) | undefined | void>;
    server: () => Promise<PluginResult>;
  };
};

let pluginMod: PluginModule["default"];
let pluginFn: PluginModule["default"]["server"];
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
  const mod = (await import("../../plugin/index.js")) as unknown as PluginModule;
  pluginMod = mod.default;
  // V1 hook 工厂：从组合薄壳的 server 字段取（对应 opencode v1 的加载路径）。
  pluginFn = mod.default.server;
});

afterAll(() => {
  if (prevStateDir === undefined) delete process.env.COMMANDCODE_PROVIDER_STATE_DIR;
  else process.env.COMMANDCODE_PROVIDER_STATE_DIR = prevStateDir;
  if (prevCatalogUrl === undefined) delete process.env.COMMANDCODE_CATALOG_URL;
  else process.env.COMMANDCODE_CATALOG_URL = prevCatalogUrl;
  rmSync(testStateDir, { recursive: true, force: true });
  restoreBundledCatalog();
});

// one-package 双版本组合薄壳：V2 读 id/setup，V1 读 server()。
test("default export exposes id, setup (V2) and server (V1)", () => {
  expect(pluginMod.id).toBe("commandcode");
  expect(typeof pluginMod.setup).toBe("function");
  expect(typeof pluginMod.server).toBe("function");
});

// opencode v2 的目录入口链路：先 server.* 再 index.*，plugin/index.ts 不是自动候选，
// 因此 index.ts（package main）的 default 必须与 plugin/index.ts 的 default 是同一个组合对象。
test("index.ts default is the same composed shell as plugin/index.ts", async () => {
  const indexMod = (await import("../../index.ts")) as unknown as {
    default: PluginModule["default"];
    createCommandCode: unknown;
  };
  expect(indexMod.default).toBe(pluginMod);
  expect(indexMod.default.id).toBe("commandcode");
  expect(typeof indexMod.default.setup).toBe("function");
  expect(typeof indexMod.default.server).toBe("function");
  // createCommandCode 命名导出保持不变
  expect(typeof indexMod.createCommandCode).toBe("function");
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

function makeModels(count: number): ModelEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `test-model-${i}`,
    name: `Test Model ${i}`,
    tier: "open-source" as const,
    reasoning: false,
    tool_call: true,
    cost: { input: 1, output: 2 },
    limit: { context: 1000, output: 100 },
  }));
}

// 指向不可路由的本地端口：让 remote 拉取确定性地失败，不依赖真实网络。
const UNREACHABLE_CATALOG_URL = "http://127.0.0.1:9/models.json";

async function withCatalogEnv<T>(
  stateDir: string,
  catalogUrl: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prevDir = process.env.COMMANDCODE_PROVIDER_STATE_DIR;
  const prevUrl = process.env.COMMANDCODE_CATALOG_URL;
  process.env.COMMANDCODE_PROVIDER_STATE_DIR = stateDir;
  process.env.COMMANDCODE_CATALOG_URL = catalogUrl;
  try {
    return await fn();
  } finally {
    if (prevDir === undefined) delete process.env.COMMANDCODE_PROVIDER_STATE_DIR;
    else process.env.COMMANDCODE_PROVIDER_STATE_DIR = prevDir;
    if (prevUrl === undefined) delete process.env.COMMANDCODE_CATALOG_URL;
    else process.env.COMMANDCODE_CATALOG_URL = prevUrl;
  }
}

async function runConfig(): Promise<Record<string, unknown>> {
  const plugin = await pluginFn();
  const config: Record<string, unknown> = { provider: { commandcode: {} } };
  await plugin.config(config);
  return (config.provider as Record<string, Record<string, unknown>>).commandcode;
}

function readSummary(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "startup.json"), "utf-8")) as Record<string, unknown>;
}

test("CA-06: prefers newer cache over bundled when remote is unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ca06-"));
  writeCatalogCache(dir, makeModels(2), {
    source: "remote",
    generatedAt: "2027-01-01T00:00:00.000Z",
  });
  try {
    await withCatalogEnv(dir, UNREACHABLE_CATALOG_URL, async () => {
      const cc = await runConfig();
      expect(Object.keys(cc.models as object).length).toBeGreaterThan(0);

      const summary = readSummary(dir);
      expect(summary.catalogSource).toBe("cache");
      expect(summary.modelCount).toBe(2);
      expect(summary.degraded).toBe(true);
      expect(summary.degradedReason).toContain("last-good cache");
      expect(summary.catalogGeneratedAt).toBe("2027-01-01T00:00:00.000Z");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CA-07: bundled wins over legacy cache with fewer models", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ca07-"));
  // 旧格式缓存：裸 ModelEntry[]，无时间戳，模型数量少于包内目录
  writeFileSync(join(dir, "catalog-cache.json"), JSON.stringify(makeModels(1)), "utf-8");
  try {
    await withCatalogEnv(dir, UNREACHABLE_CATALOG_URL, async () => {
      await runConfig();
      const summary = readSummary(dir);
      expect(summary.catalogSource).toBe("bundled");
      expect(summary.modelCount).toBeGreaterThan(20);
      expect(summary.degraded).toBe(true);
      // 远程不可用时降级到包内目录；具体原因文案取决于 manifest.status：
      // healthy → "frozen at package version"，degraded/broken → 覆盖为状态专属原因
      //（见 core/source.ts bundledStatus 分支）。两者都说明走了 bundled，断言放宽以兼容 CI 更新。
      expect(summary.degradedReason).toMatch(
        /frozen at package version|no listed price|marked broken/,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CA-08: timestamp outranks model count when both are known", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ca08-"));
  // 模型更多但时间更旧：包内目录（manifest.generatedAt 更新）应胜出
  writeCatalogCache(dir, makeModels(99), {
    source: "remote",
    generatedAt: "2000-01-01T00:00:00.000Z",
  });
  try {
    await withCatalogEnv(dir, UNREACHABLE_CATALOG_URL, async () => {
      await runConfig();
      const summary = readSummary(dir);
      expect(summary.catalogSource).toBe("bundled");
      expect(summary.modelCount).toBeLessThan(99);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CA-09: bundled catalog is never written into the cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ca09-"));
  try {
    await withCatalogEnv(dir, "disabled", async () => {
      await runConfig();
      const summary = readSummary(dir);
      expect(summary.catalogSource).toBe("bundled");
      expect(existsSync(join(dir, "catalog-cache.json"))).toBe(false);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CA-10: remote success writes cache with freshness metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ca10-"));
  const payload = makeModels(3);
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json(payload),
  });
  try {
    await withCatalogEnv(dir, `http://127.0.0.1:${server.port}/models.json`, async () => {
      await runConfig();
      const summary = readSummary(dir);
      expect(summary.catalogSource).toBe("remote");
      expect(summary.modelCount).toBe(3);
      expect(summary.degraded).toBe(false);

      const cached = JSON.parse(readFileSync(join(dir, "catalog-cache.json"), "utf-8")) as {
        source: string;
        modelCount: number;
        generatedAt: string;
        models: ModelEntry[];
      };
      expect(cached.source).toBe("remote");
      expect(cached.modelCount).toBe(3);
      expect(typeof cached.generatedAt).toBe("string");
      expect(cached.models.length).toBe(3);
    });
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── V2 adapter（Plugin.define + ctx.provider.transform + ctx.integration.transform）──
// 复现 opencode v2 的两个 domain editor：只在回调里收集/应用 editor 的写入。
//   * provider.transform：add 注册 provider 记录，update(id, cb) 原地改该记录；
//   * integration.transform：method.update({integrationID, method}) 注册认证方法
//     （会顺带创建同名 integration 记录），update(id, cb) 改 integration 的展示名。

type V2Registration = {
  info: Record<string, unknown>;
  models: Array<Record<string, unknown>>;
};

type V2ProviderEditor = {
  add: (input: V2Registration) => void;
  update: (providerID: string, update: (info: Record<string, unknown>) => void) => void;
};

type V2MethodRegistration = {
  integrationID: string;
  method: Record<string, unknown>;
};

type V2IntegrationRef = { id: string; name: string };

type V2IntegrationEditor = {
  method: { update: (input: V2MethodRegistration) => void };
  update: (integrationID: string, update: (ref: V2IntegrationRef) => void) => void;
};

async function runV2Setup(): Promise<{
  registration: V2Registration;
  providerInfo: Record<string, unknown>;
  methods: V2MethodRegistration[];
  integrations: Record<string, V2IntegrationRef>;
  cleanup: (() => void) | undefined;
}> {
  const registrations: V2Registration[] = [];
  const methods: V2MethodRegistration[] = [];
  const infos = new Map<string, Record<string, unknown>>();
  const integrations: Record<string, V2IntegrationRef> = {};

  const ctx = {
    provider: {
      transform: async (callback: (editor: V2ProviderEditor) => void) => {
        callback({
          add: (input) => {
            registrations.push(input);
            infos.set(String(input.info.id), input.info);
          },
          update: (providerID, update) => {
            const info = infos.get(providerID) ?? { id: providerID };
            infos.set(providerID, info);
            update(info);
          },
        });
      },
    },
    integration: {
      transform: async (callback: (editor: V2IntegrationEditor) => void) => {
        callback({
          method: {
            update: (input) => {
              methods.push(input);
              // 真实运行时：方法注册会顺带创建 integration，name 默认取 id
              integrations[input.integrationID] ??= {
                id: input.integrationID,
                name: input.integrationID,
              };
            },
          },
          update: (integrationID, update) => {
            integrations[integrationID] ??= { id: integrationID, name: integrationID };
            update(integrations[integrationID] as V2IntegrationRef);
          },
        });
      },
    },
  };
  const cleanup = await pluginMod.setup(ctx);
  expect(registrations.length).toBe(1);
  const registration = registrations[0] as V2Registration;
  return {
    registration,
    providerInfo: infos.get("commandcode") ?? {},
    methods,
    integrations,
    cleanup: cleanup ?? undefined,
  };
}

test("CA-11: V2 setup registers provider info and models via provider.transform", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-v2-"));
  try {
    await withCatalogEnv(dir, "disabled", async () => {
      const { registration, cleanup } = await runV2Setup();
      const { info, models } = registration;

      expect(info.id).toBe("commandcode");
      expect(info.name).toBe("Command Code");
      expect(info.activation).toBe("enabled");
      expect(info.package).toBe("@opencode/ai/providers/openai-compatible");

      // V2 Provider.Info 没有 env / apiKey 字段：API key 走 settings 的 env 模板。
      expect(info.env).toBeUndefined();
      expect(info.apiKey).toBeUndefined();
      const settings = info.settings as Record<string, unknown>;
      expect(settings.baseURL).toBe("https://api.commandcode.ai/provider/v1/");
      expect(settings.provider).toBe("commandcode");
      expect(settings.apiKey).toBe("{env:COMMANDCODE_API_KEY}");

      expect(models.length).toBeGreaterThan(20);
      const sample = models[0] as Record<string, unknown>;
      expect(sample.providerID).toBe("commandcode");
      expect(Array.isArray(sample.cost)).toBe(true);
      expect(typeof (sample.capabilities as Record<string, unknown>).tools).toBe("boolean");

      // reasoningEfforts → variants[].settings.reasoningEffort
      const withVariants = models.filter(
        (m) => Array.isArray(m.variants) && (m.variants as unknown[]).length > 0,
      );
      expect(withVariants.length).toBeGreaterThan(0);
      const variants = (withVariants[0] as Record<string, unknown>).variants as Array<
        Record<string, unknown>
      >;
      const variant = variants[0] ?? {};
      const variantSettings = variant.settings as Record<string, unknown>;
      expect(typeof variant.id).toBe("string");
      expect(variantSettings.reasoningEffort).toBe(variant.id);

      // setup 的返回值对应 V1 的 dispose：无持久资源，调用不应抛错。
      expect(typeof cleanup).toBe("function");
      if (cleanup) cleanup();

      const summary = readSummary(dir);
      expect(summary.catalogSource).toBe("bundled");
      expect(summary.modelCount).toBe(models.length);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CA-12: V2 setup caches remote catalog and writes summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-v2-remote-"));
  const payload = makeModels(3);
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json(payload),
  });
  try {
    await withCatalogEnv(dir, `http://127.0.0.1:${server.port}/models.json`, async () => {
      const { registration } = await runV2Setup();
      expect(registration.models.length).toBe(3);

      const summary = readSummary(dir);
      expect(summary.catalogSource).toBe("remote");
      expect(summary.modelCount).toBe(3);
      expect(summary.degraded).toBe(false);

      const cached = JSON.parse(readFileSync(join(dir, "catalog-cache.json"), "utf-8")) as {
        source: string;
        models: ModelEntry[];
      };
      expect(cached.source).toBe("remote");
      expect(cached.models.length).toBe(3);
    });
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CA-13: V2 setup registers commandcode integration with key and env methods", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-v2-auth-"));
  try {
    await withCatalogEnv(dir, "disabled", async () => {
      const { methods, integrations, providerInfo } = await runV2Setup();

      // key 方法：`opencode auth login` 的候选列表会过滤掉只有 env 方法的 integration，
      // 因此必须有 key 方法才能选到 commandcode（本次改动的核心目的）。
      const keyMethods = methods.filter(
        (m) => m.integrationID === "commandcode" && m.method.type === "key",
      );
      expect(keyMethods.length).toBe(1);
      expect(keyMethods[0]?.method.label).toBe("CommandCode API Key");

      // env 方法：COMMANDCODE_API_KEY 命中时算一条 env connection（auth list 显示已连接）
      const envMethods = methods.filter(
        (m) => m.integrationID === "commandcode" && m.method.type === "env",
      );
      expect(envMethods.length).toBe(1);
      expect(envMethods[0]?.method.names).toEqual(["COMMANDCODE_API_KEY"]);

      // 注册 integration 后 provider 可用性不能再依赖「无同名 integration」分支，
      // 必须显式 activation === "enabled"，否则无凭证时整个 provider 不可用。
      expect(providerInfo.activation).toBe("enabled");

      // integration 展示名（auth 列表 / 选择器标题）
      expect(integrations.commandcode?.name).toBe("Command Code");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
