import { expect, test, describe } from "bun:test";
import {
  buildModelEntry,
  disambiguateModelNames,
  generateOpencodeModels,
  loadCatalogFromBundle,
  resolveCommandCodePackage,
  type CostEntry,
  type SnEntry,
} from "../../src/catalog.ts";

function costMapOf(entries: CostEntry[]): Map<string, CostEntry> {
  const map = new Map<string, CostEntry>();
  for (const entry of entries) {
    const colonIdx = entry.id.indexOf(":");
    const bareId = colonIdx >= 0 ? entry.id.slice(colonIdx + 1) : entry.id;
    map.set(bareId, entry);
  }
  return map;
}

const sampleCost: CostEntry = {
  id: "anthropic:claude-sonnet-4-6",
  provider: "anthropic",
  category: "premium",
  promptCost: 3,
  completionCost: 15,
  cacheWrite5mCost: 3.75,
  cacheWrite1hCost: 6,
  cacheHitCost: 0.3,
};

describe("buildModelEntry", () => {
  test("preserves reasoningEfforts and sets reasoning true", () => {
    const sn: SnEntry = {
      id: "claude-sonnet-4-6",
      provider: "anthropic",
      spec: "chatComplete",
      label: "Sonnet",
      name: "Claude Sonnet 4.6",
      description: "test",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    };
    const entry = buildModelEntry(sn, costMapOf([sampleCost]));
    expect(entry).not.toBeNull();
    expect(entry!.reasoning).toBe(true);
    expect(entry!.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(entry!.tier).toBe("premium");
  });

  test("omits reasoningEfforts when absent and reasoning false", () => {
    const sn: SnEntry = {
      id: "claude-sonnet-4-6",
      provider: "anthropic",
      spec: "chatComplete",
      label: "Sonnet",
      name: "Claude Sonnet 4.6",
      description: "test",
    };
    const entry = buildModelEntry(sn, costMapOf([sampleCost]));
    expect(entry).not.toBeNull();
    expect(entry!.reasoning).toBe(false);
    expect(entry!.reasoningEfforts).toBeUndefined();
  });

  test("sets reasoning true from explicit flag without efforts", () => {
    const sn: SnEntry = {
      id: "claude-sonnet-4-6",
      provider: "anthropic",
      spec: "chatComplete",
      label: "Sonnet",
      name: "Claude Sonnet 4.6",
      description: "test",
      reasoning: true,
    };
    const entry = buildModelEntry(sn, costMapOf([sampleCost]));
    expect(entry!.reasoning).toBe(true);
    expect(entry!.reasoningEfforts).toBeUndefined();
  });

  test("keeps models without cost data using default cost", () => {
    const sn: SnEntry = {
      id: "new-provider/new-reasoning-model",
      provider: "openrouter",
      spec: "chatComplete",
      label: "X",
      name: "X",
      description: "x",
      reasoningEfforts: ["low", "high"],
    };
    const entry = buildModelEntry(sn, new Map());
    expect(entry).not.toBeNull();
    expect(entry!.reasoning).toBe(true);
    expect(entry!.reasoningEfforts).toEqual(["low", "high"]);
    expect(entry!.cost).toEqual({ input: 0.5, output: 2 });
  });

  test("maps CLI inputModalities to attachment and modalities for every SKU", () => {
    const vision = buildModelEntry(
      {
        id: "google/gemini-3.5-flash",
        provider: "vercel-ai-gateway",
        spec: "chatComplete",
        label: "Gemini",
        name: "Gemini 3.5 Flash",
        description: "d",
        inputModalities: ["text", "image"],
        contextWindow: 1e6,
      },
      new Map(),
    );
    const text = buildModelEntry(
      {
        id: "tencent/hy4-preview",
        provider: "vercel-ai-gateway",
        spec: "chatComplete",
        label: "Hy4",
        name: "Tencent Hy4 Preview",
        description: "d",
        inputModalities: ["text"],
        contextWindow: 1048576,
        maxOutputTokens: 64000,
      },
      new Map(),
    );
    expect(vision!.attachment).toBe(true);
    expect(vision!.modalities).toEqual({ input: ["text", "image"], output: ["text"] });
    expect(text!.attachment).toBe(false);
    expect(text!.modalities).toEqual({ input: ["text"], output: ["text"] });
    expect(text!.limit).toEqual({ context: 1048576, output: 64000 });
  });

  test("does not invent a billed rate for models missing from the CLI cost map", () => {
    const sn: SnEntry = {
      id: "google/gemini-3.5-flash",
      provider: "openrouter",
      spec: "chatComplete",
      label: "Gemini",
      name: "Gemini 3.5 Flash",
      description: "x",
    };
    const entry = buildModelEntry(sn, new Map());
    expect(entry!.cost).toEqual({ input: 0.5, output: 2 });
  });
});

describe("disambiguateModelNames", () => {
  test("distinguishes models with the same upstream display name", () => {
    const entries = [
      {
        id: "MiniMaxAI/MiniMax-M3-Free",
        name: "MiniMax M3",
        tier: "open-source" as const,
        reasoning: true,
        tool_call: true,
        cost: { input: 0.5, output: 2 },
        limit: { context: 1000000, output: 65536 },
      },
      {
        id: "MiniMaxAI/MiniMax-M3",
        name: "MiniMax M3",
        tier: "open-source" as const,
        reasoning: true,
        tool_call: true,
        cost: { input: 0.5, output: 2 },
        limit: { context: 1000000, output: 65536 },
      },
    ];

    disambiguateModelNames(entries);
    expect(entries.map((entry) => entry.name).sort()).toEqual(["MiniMax M3", "MiniMax M3 Free"]);
  });
});

describe("generateOpencodeModels", () => {
  test("emits variants from reasoningEfforts", () => {
    const models = generateOpencodeModels([
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        tier: "premium",
        reasoning: true,
        reasoningEfforts: ["low", "high"],
        tool_call: true,
        cost: { input: 3, output: 15 },
        limit: { context: 200000, output: 16000 },
      },
    ]);
    const entry = models["claude-sonnet-4-6"] as Record<string, unknown>;
    expect(entry.reasoningEfforts).toEqual(["low", "high"]);
    expect(entry.variants).toEqual({
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
    });
  });

  test("emits attachment and modalities, defaulting to text-only", () => {
    const models = generateOpencodeModels([
      {
        id: "google/gemini-3.5-flash",
        name: "Gemini 3.5 Flash",
        tier: "open-source",
        reasoning: false,
        tool_call: true,
        cost: { input: 1.5, output: 9 },
        limit: { context: 1048576, output: 65536 },
        attachment: true,
        modalities: { input: ["text", "image"], output: ["text"] },
      },
      {
        id: "tencent/hy4-preview",
        name: "Tencent Hy4 Preview",
        tier: "open-source",
        reasoning: true,
        tool_call: true,
        cost: { input: 0.834, output: 2.501 },
        limit: { context: 1048576, output: 64000 },
      },
    ]);
    // key 原样保留完整 id（含首段），与 V2 字面一致，一份配置两版通用
    const gemini = models["google/gemini-3.5-flash"] as Record<string, unknown>;
    const hy4 = models["tencent/hy4-preview"] as Record<string, unknown>;
    expect(gemini.attachment).toBe(true);
    expect(gemini.modalities).toEqual({ input: ["text", "image"], output: ["text"] });
    expect(hy4.attachment).toBe(false);
    expect(hy4.modalities).toEqual({ input: ["text"], output: ["text"] });
  });

  test("CA-14: key 原样保留完整 id（含首段与大小写），不剥段不转小写", () => {
    const models = generateOpencodeModels([
      {
        id: "deepseek/deepseek-v4.1-flash",
        name: "DeepSeek V4.1 Flash",
        tier: "open-source",
        reasoning: false,
        tool_call: true,
        cost: { input: 0.5, output: 2 },
        limit: { context: 131072, output: 8192 },
      },
      {
        id: "MiniMaxAI/MiniMax-M3-Free",
        name: "MiniMax M3 Free",
        tier: "open-source",
        reasoning: false,
        tool_call: true,
        cost: { input: 0, output: 0 },
        limit: { context: 200000, output: 8192 },
      },
    ]);
    // 不剥首段（deepseek/、MiniMaxAI/ 都保留），不转小写（MiniMaxAI 大小写原样）
    expect(Object.keys(models).sort()).toEqual([
      "MiniMaxAI/MiniMax-M3-Free",
      "deepseek/deepseek-v4.1-flash",
    ]);
    // 内部多段 id 也原样成为 key（防回归：任何剥段逻辑都会破坏该形态）
    expect(models["deepseek/deepseek-v4.1-flash"]).toBeDefined();
  });
});

describe("loadCatalogFromBundle", () => {
  test("extracts models and reasoningEfforts from minified-like fixture", () => {
    // Mirrors command-code bundle shape: (Wt={...}), spec consts, (e=>({CATALOG})), costs
    const source = [
      '(Wt={ANTHROPIC:"anthropic",OPENAI:"openai",VERCEL_AI_GATEWAY:"vercel-ai-gateway"});',
      'var Aa="chatComplete",Ba="responses",qt=Vt[0];',
      "var Sn=(Wt=>({",
      'SONNET_4_6:{id:"claude-sonnet-4-6",provider:Wt.ANTHROPIC,spec:Aa,label:"Sonnet",name:"Claude Sonnet 4.6",description:"d",inputModalities:["text","image"],reasoning:!0,reasoningEfforts:["low","medium","high"],contextWindow:2e5},',
      'GPT_X:{id:"gpt-5.5",provider:Wt.OPENAI,spec:Ba,label:"GPT",name:"GPT-5.5",description:"d",inputModalities:["text"],reasoningEfforts:["low","high"],contextWindow:256000}',
      "}))(Wt);",
      'var costs={anthropic:[{id:"anthropic:claude-sonnet-4-6",provider:"anthropic",category:"p",promptCost:3,completionCost:15,cacheWrite5mCost:3.75,cacheWrite1hCost:6,cacheHitCost:.3}],openai:[{id:"openai:gpt-5.5",provider:"openai",category:"p",promptCost:1,completionCost:2,cacheWrite5mCost:0,cacheWrite1hCost:0,cacheHitCost:0}]};',
    ].join("");

    const entries = loadCatalogFromBundle(source);
    expect(entries.length).toBeGreaterThanOrEqual(2);

    const sonnet = entries.find((e) => e.id === "claude-sonnet-4-6");
    expect(sonnet).toBeDefined();
    expect(sonnet!.reasoning).toBe(true);
    expect(sonnet!.reasoningEfforts).toEqual(["low", "medium", "high"]);
    expect(sonnet!.tier).toBe("premium");
    expect(sonnet!.limit.context).toBe(200000);
    expect(sonnet!.attachment).toBe(true);
    expect(sonnet!.modalities).toEqual({ input: ["text", "image"], output: ["text"] });

    const gpt = entries.find((e) => e.id === "gpt-5.5");
    expect(gpt).toBeDefined();
    expect(gpt!.reasoning).toBe(true);
    expect(gpt!.reasoningEfforts).toEqual(["low", "high"]);
    expect(gpt!.attachment).toBe(false);
    expect(gpt!.modalities).toEqual({ input: ["text"], output: ["text"] });
  });

  test("binds string vars prefixed with $ (minifier shape) for catalog eval", () => {
    // command-code 1.40 bundles provider/spec constants into $R="..."-style vars;
    // a \b boundary skips "$" and breaks evaluation of the model catalog object.
    const source = [
      'var $R="vercel-ai-gateway",KR="chatComplete",qR="responses";',
      'var Sn=($R=>({SONNET_4_6:{id:"claude-sonnet-4-6",provider:$R,spec:KR,label:"Sonnet",name:"Claude Sonnet 4.6",description:"d",reasoning:!0,reasoningEfforts:["low","high"],contextWindow:2e5},GPT_X:{id:"gpt-5.5",provider:"openai",spec:qR,label:"GPT",name:"GPT-5.5",description:"d",inputModalities:["text"]}}))($R);',
    ].join("");

    const entries = loadCatalogFromBundle(source);
    const sonnet = entries.find((e) => e.id === "claude-sonnet-4-6");
    expect(sonnet).toBeDefined();
    expect(sonnet!.reasoningEfforts).toEqual(["low", "high"]);
  });

  test("surfaces the real eval error when no candidate evaluates", () => {
    // Bundle shape where the catalog references an unbindable identifier:
    // the thrown error must name it, not the generic extraction failure.
    const source = [
      'var KR="chatComplete",qR="responses";',
      'var Sn={SONNET_4_6:{id:"claude-sonnet-4-6",provider:$TOTALLY_MISSING,spec:KR,label:"Sonnet",name:"Claude Sonnet 4.6",description:"d"},GPT_X:{id:"gpt-5.5",provider:"openai",spec:KR,label:"GPT",name:"GPT-5.5",description:"d"}};',
    ].join("");

    expect(() => loadCatalogFromBundle(source)).toThrow(/\$TOTALLY_MISSING/);
  });

  test("returns models when cost extraction fails", () => {
    const source = [
      '(Wt={ANTHROPIC:"anthropic",OPENAI:"openai",VERCEL_AI_GATEWAY:"vercel-ai-gateway"});',
      'var Aa="chatComplete",Ba="responses",qt=Vt[0];',
      "var Sn=(Wt=>({",
      'SONNET_4_6:{id:"claude-sonnet-4-6",provider:Wt.ANTHROPIC,spec:Aa,label:"Sonnet",name:"Claude Sonnet 4.6",description:"d",inputModalities:["text","image"],reasoning:!0,reasoningEfforts:["low","medium","high"],contextWindow:2e5},',
      'GPT_X:{id:"gpt-5.5",provider:Wt.OPENAI,spec:Ba,label:"GPT",name:"GPT-5.5",description:"d",inputModalities:["text"],reasoningEfforts:["low","high"],contextWindow:256000}',
      "}))(Wt);",
    ].join("");

    const entries = loadCatalogFromBundle(source);
    const sonnet = entries.find((e) => e.id === "claude-sonnet-4-6");
    expect(sonnet).toBeDefined();
    expect(sonnet!.reasoningEfforts).toEqual(["low", "medium", "high"]);
    expect(sonnet!.cost).toEqual({ input: 0.5, output: 2 });
  });
});

describe("resolveCommandCodePackage", () => {
  test("returns null for missing explicit path without throwing", () => {
    const prev = process.env.COMMANDCODE_PACKAGE_PATH;
    delete process.env.COMMANDCODE_PACKAGE_PATH;
    try {
      const result = resolveCommandCodePackage({
        packagePath: "D:\\definitely-not-a-real-command-code-path-xyz",
      });
      // May still find a global install; explicit bad path alone is ignored after fail
      // and resolution continues. Ensure no throw and shape is valid when present.
      if (result) {
        expect(result.root).toBeTruthy();
        expect(result.bundlePath).toBeTruthy();
        expect(result.version).toBeTruthy();
      } else {
        expect(result).toBeNull();
      }
    } finally {
      if (prev !== undefined) process.env.COMMANDCODE_PACKAGE_PATH = prev;
    }
  });

  test("resolves explicit package root when valid", () => {
    // If command-code is installed globally/locally, resolve it and re-resolve via path
    const found = resolveCommandCodePackage();
    if (!found) {
      expect(found).toBeNull();
      return;
    }
    const again = resolveCommandCodePackage({ packagePath: found.root });
    expect(again).not.toBeNull();
    expect(again!.root).toBe(found.root);
    expect(again!.bundlePath).toBe(found.bundlePath);
  });
});
