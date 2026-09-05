import { createRequire } from "module";
import { execSync } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join, resolve as resolvePath } from "path";

export const NPM_PACKAGE = "command-code";

export interface ModelEntry {
  id: string;
  name: string;
  tier: "premium" | "open-source";
  reasoning: boolean;
  reasoningEfforts?: string[];
  tool_call: boolean;
  cost: { input: number; output: number; cache_read?: number; cache_write?: number };
  limit: { context: number; output: number };
  attachment?: boolean;
  modalities?: { input: string[]; output: string[] };
}

export interface CostEntry {
  id: string;
  provider: string;
  category: string;
  promptCost: number;
  completionCost: number;
  cacheWrite5mCost: number;
  cacheWrite1hCost: number;
  cacheHitCost: number;
}

export interface SnEntry {
  id: string;
  provider: string;
  spec: string;
  label: string;
  name: string;
  description: string;
  reasoning?: boolean;
  reasoningEfforts?: string[];
  contextWindow?: number;
  inputModalities?: string[];
  maxOutputTokens?: number;
}

export interface ResolvedCommandCodePackage {
  root: string;
  bundlePath: string;
  version: string;
}

export interface LocalCatalogResult {
  models: ModelEntry[];
  version: string;
  root: string;
  bundleSource: string;
}

export const FALLBACK_LIMITS: Record<string, { context: number; output: number }> = {
  "claude-haiku-4-5-20251001": { context: 200000, output: 8192 },
  "claude-opus-4-6": { context: 200000, output: 32000 },
  "claude-opus-4-7": { context: 200000, output: 32000 },
  "claude-sonnet-4-6": { context: 200000, output: 16000 },
  "gpt-5.5": { context: 256000, output: 128000 },
  "gpt-5.4": { context: 256000, output: 128000 },
  "gpt-5.3-codex": { context: 256000, output: 128000 },
  "gpt-5.4-mini": { context: 256000, output: 128000 },
  "moonshotai/Kimi-K2.6": { context: 262144, output: 131072 },
  "moonshotai/Kimi-K2.5": { context: 262144, output: 131072 },
  "zai-org/GLM-5": { context: 200000, output: 131072 },
  "zai-org/GLM-5.1": { context: 200000, output: 131072 },
  "MiniMaxAI/MiniMax-M2.5": { context: 1000000, output: 131072 },
  "MiniMaxAI/MiniMax-M2.7": { context: 1000000, output: 131072 },
  "deepseek/deepseek-v4-pro": { context: 1000000, output: 384000 },
  "deepseek/deepseek-v4-flash": { context: 1000000, output: 384000 },
  "Qwen/Qwen3.6-Max-Preview": { context: 1000000, output: 131072 },
  "Qwen/Qwen3.6-Plus": { context: 1000000, output: 131072 },
  "Qwen/Qwen3.7-Max": { context: 1000000, output: 131072 },
  "stepfun/Step-3.5-Flash": { context: 1000000, output: 131072 },
  "google/gemini-3.5-flash": { context: 1000000, output: 65536 },
  "google/gemini-3.1-flash-lite": { context: 1000000, output: 65536 },
};

export const HARDCODED_EXTRAS: SnEntry[] = [
  {
    id: "Qwen/Qwen3.7-Max",
    provider: "vercel-ai-gateway",
    spec: "chatComplete",
    label: "Qwen 3.7 Max",
    name: "Qwen 3.7 Max",
    description: "latest Qwen Max model",
    reasoning: true,
  },
];

export const TIER_MAP: Record<string, "premium" | "open-source"> = {
  anthropic: "premium",
  openai: "premium",
  baseten: "open-source",
  "vercel-ai-gateway": "open-source",
  openrouter: "open-source",
  "cloudflare-ai-gateway": "open-source",
};

const CATALOG_ANCHOR = 'SONNET_4_6:{id:"claude-sonnet-4-6"';
const COST_ANCHORS = [
  '{id:"anthropic:claude-sonnet-4-',
  '{id:"anthropic:claude-sonnet-5"',
  '{id:"anthropic:claude-sonnet-4-6"',
] as const;

/** Object after `(` (legacy IIFE / enum form): `(Wt={...})` */
export function findBalancedObject(source: string, anchor: string): string {
  const anchorIdx = source.indexOf(anchor);
  if (anchorIdx < 0) throw new Error(`Anchor not found: ${anchor}`);

  let parenIdx = anchorIdx - 1;
  while (parenIdx >= 0 && source[parenIdx] !== "(") parenIdx--;
  if (parenIdx < 0) throw new Error(`Could not find opening ( before anchor: ${anchor}`);

  const braceStart = source.indexOf("{", parenIdx);
  if (braceStart < 0) throw new Error(`Could not find { after opening (`);

  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end++) {
    if (source[end] === "{") depth++;
    else if (source[end] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }

  return source.slice(braceStart, end + 1);
}

/** All balanced `{...}` spans that contain the anchor, innermost → outermost. */
export function findEnclosingObjectCandidates(
  source: string,
  anchor: string,
  fromIndex = 0,
): string[] {
  const anchorIdx = source.indexOf(anchor, fromIndex);
  if (anchorIdx < 0) throw new Error(`Anchor not found: ${anchor}`);

  const stack: number[] = [];
  for (let i = 0; i <= anchorIdx; i++) {
    const ch = source[i];
    if (ch === "{") stack.push(i);
    else if (ch === "}") stack.pop();
  }
  if (stack.length === 0) throw new Error(`Could not find enclosing { for anchor: ${anchor}`);

  const MAX = 2_000_000;
  const out: string[] = [];
  // innermost first
  for (let s = stack.length - 1; s >= 0; s--) {
    const start = stack[s];
    if (start === undefined) continue;
    let depth = 0;
    let end = start;
    for (; end < source.length; end++) {
      if (source[end] === "{") depth++;
      else if (source[end] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (end >= source.length || end < anchorIdx) continue;
    if (end + 1 - start > MAX) continue;
    out.push(source.slice(start, end + 1));
  }
  if (out.length === 0) throw new Error(`Could not close enclosing { for anchor: ${anchor}`);
  return out;
}

/** Default: innermost enclosing object (good for plain catalogs). */
export function findEnclosingObject(source: string, anchor: string, fromIndex = 0): string {
  const first = findEnclosingObjectCandidates(source, anchor, fromIndex)[0];
  if (!first) throw new Error(`Could not find enclosing object for anchor: ${anchor}`);
  return first;
}

export function evaluateWithContext(code: string, context: Record<string, unknown>): any {
  const keys = Object.keys(context);
  const values = keys.map((k) => context[k]);
  const fn = Function(...keys, `"use strict"; return (${code})`);
  return fn(...values);
}

export function normalizeForEval(code: string): string {
  return code
    .replace(/!0/g, "true")
    .replace(/!1/g, "false")
    .replace(/(\d+)e(\d+)/g, (_: string, m: string, e: string) =>
      String(Number(m) * Math.pow(10, Number(e))),
    );
}

function getVarNameBefore(source: string, anchorIdx: number): string | null {
  const before = source.slice(Math.max(0, anchorIdx - 50), anchorIdx);
  const match = before.match(/\(([A-Za-z_$]+)=\{$/);
  if (match?.[1]) return match[1];
  const match2 = before.match(/([A-Za-z_$]+)=\{$/);
  if (match2?.[1]) return match2[1];
  return null;
}

/** Prefer provider enums that include gateway/openai keys over UI-only enums. */
export function extractBestProviderEnum(
  source: string,
): { name: string; value: Record<string, string> } | null {
  const anchor = 'ANTHROPIC:"anthropic"';
  let from = 0;
  let fallback: { name: string; value: Record<string, string> } | null = null;

  while (from < source.length) {
    const idx = source.indexOf(anchor, from);
    if (idx < 0) break;
    try {
      let parenIdx = idx - 1;
      while (parenIdx >= 0 && source[parenIdx] !== "(") parenIdx--;
      if (parenIdx < 0) {
        from = idx + 1;
        continue;
      }
      const braceStart = source.indexOf("{", parenIdx);
      if (braceStart < 0 || braceStart > idx) {
        from = idx + 1;
        continue;
      }
      let depth = 0;
      let end = braceStart;
      for (; end < source.length; end++) {
        if (source[end] === "{") depth++;
        else if (source[end] === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      const obj = source.slice(braceStart, end + 1);
      const value = evaluateWithContext(normalizeForEval(obj), {}) as Record<string, string>;
      const name = getVarNameBefore(source, idx) || "Wt";
      const rich =
        "OPENAI" in value ||
        "BASETEN" in value ||
        "VERCEL_AI_GATEWAY" in value ||
        Object.values(value).includes("openai");
      const hit = { name, value };
      if (rich) return hit;
      if (!fallback) fallback = hit;
    } catch {
      // try next occurrence
    }
    from = idx + 1;
  }

  return fallback;
}

/** Collect nearby `name="value"` bindings and simple aliases (`tI=Qx`). */
export function extractStringBindings(
  source: string,
  endIdx: number,
  window = 12000,
): Record<string, string> {
  const before = source.slice(Math.max(0, endIdx - window), endIdx);
  const bindings: Record<string, string> = {};
  // \b does not fire before "$" (not a word char); minified bundles use names like
  // $R="vercel-ai-gateway". A lookbehind boundary handles both $ and letter names.
  const strRe = /(?<![A-Za-z0-9_$])([A-Za-z_$][\w$]*)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = strRe.exec(before))) {
    const name = m[1];
    const value = m[2];
    if (name !== undefined && value !== undefined) bindings[name] = value;
  }
  for (let pass = 0; pass < 4; pass++) {
    const aliasRe = /(?<![A-Za-z0-9_$])([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)(?![A-Za-z0-9_$])/g;
    while ((m = aliasRe.exec(before))) {
      const alias = m[1];
      const target = m[2];
      if (alias === undefined || target === undefined || bindings[alias] !== undefined) continue;
      const resolved = bindings[target];
      if (resolved !== undefined) bindings[alias] = resolved;
    }
  }
  return bindings;
}

export function extractSpecConstants(source: string): {
  chatComplete: string;
  responses: string;
  qt: string;
} {
  const anchorIdx = source.indexOf(CATALOG_ANCHOR);
  if (anchorIdx < 0) throw new Error("Could not find model catalog anchor");

  const before = source.slice(Math.max(0, anchorIdx - 5000), anchorIdx);

  const chatMatch = before.match(/([A-Za-z_$]+)="chatComplete"/);
  const respMatch = before.match(/([A-Za-z_$]+)="responses"/);
  const chatName = chatMatch?.[1];
  const respName = respMatch?.[1];
  if (!chatName || !respName) throw new Error("Could not find spec constants");

  const qtMatch = before.match(/([A-Za-z_$]+)=Vt\[0\]/);
  const qtVar = qtMatch?.[1] ?? "";

  return {
    chatComplete: chatName,
    responses: respName,
    qt: qtVar,
  };
}

function buildEvalContext(source: string, catalogIdx: number): Record<string, unknown> {
  const ctx: Record<string, unknown> = {
    ...extractStringBindings(source, catalogIdx),
  };

  const spec = extractSpecConstants(source);
  ctx[spec.chatComplete] = ctx[spec.chatComplete] ?? "chatComplete";
  ctx[spec.responses] = ctx[spec.responses] ?? "responses";

  const providerEnum = extractBestProviderEnum(source);
  if (providerEnum) {
    ctx[providerEnum.name] = providerEnum.value;
    if (spec.qt && providerEnum.value.VERCEL_AI_GATEWAY) {
      ctx[spec.qt] = providerEnum.value.VERCEL_AI_GATEWAY;
    }
  }

  return ctx;
}

function isModelCatalog(value: unknown): value is Record<string, SnEntry> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const vals = Object.values(value as Record<string, unknown>);
  if (vals.length < 2) return false;
  let modelish = 0;
  for (const v of vals) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof (v as SnEntry).id === "string" &&
      typeof (v as SnEntry).name === "string"
    ) {
      modelish++;
    }
  }
  return modelish >= 2;
}

export function extractModelCatalog(
  source: string,
  wt?: Record<string, string>,
  wtName?: string,
  spec?: ReturnType<typeof extractSpecConstants>,
): Record<string, SnEntry> {
  const catalogIdx = source.indexOf(CATALOG_ANCHOR);
  if (catalogIdx < 0) throw new Error("Could not find model catalog anchor");

  const ctx = buildEvalContext(source, catalogIdx);
  if (wt && wtName) ctx[wtName] = wt;
  if (spec) {
    ctx[spec.chatComplete] = "chatComplete";
    ctx[spec.responses] = "responses";
    if (spec.qt && wt?.VERCEL_AI_GATEWAY) ctx[spec.qt] = wt.VERCEL_AI_GATEWAY;
  }

  const candidates: string[] = [];
  try {
    candidates.push(...findEnclosingObjectCandidates(source, CATALOG_ANCHOR, catalogIdx));
  } catch {
    // ignore
  }
  try {
    candidates.push(findBalancedObject(source, CATALOG_ANCHOR));
  } catch {
    // ignore
  }
  if (candidates.length === 0) throw new Error("Could not locate model catalog object");

  let lastError: unknown = null;
  for (const raw of candidates) {
    try {
      const value = evaluateWithContext(normalizeForEval(raw), ctx);
      if (isModelCatalog(value)) return value;
    } catch (err) {
      // keep the first real failure (e.g. "$R is not defined") — it names the
      // missing binding; later candidates usually fail on the same cause
      lastError ??= err;
    }
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Could not evaluate model catalog${detail}`);
}

function isCostMap(value: unknown): value is Record<string, CostEntry[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const vals = Object.values(value as Record<string, unknown>);
  if (vals.length === 0) return false;
  // At least one provider bucket should be an array of cost rows
  return vals.some(
    (v) =>
      Array.isArray(v) &&
      v.length > 0 &&
      typeof v[0] === "object" &&
      v[0] !== null &&
      typeof (v[0] as CostEntry).promptCost === "number",
  );
}

export function extractCostData(
  source: string,
  wt?: Record<string, string>,
  wtName?: string,
): Record<string, CostEntry[]> {
  let anchorIdx = -1;
  let usedAnchor: string | null = null;
  for (const anchor of COST_ANCHORS) {
    const idx = source.indexOf(anchor);
    if (idx >= 0) {
      anchorIdx = idx;
      usedAnchor = anchor;
      break;
    }
  }
  if (anchorIdx < 0 || !usedAnchor) throw new Error("Could not find cost data anchor");

  const candidates = findEnclosingObjectCandidates(source, usedAnchor, anchorIdx);
  const catalogIdx = source.indexOf(CATALOG_ANCHOR);
  const ctx = buildEvalContext(source, catalogIdx >= 0 ? catalogIdx : anchorIdx);
  if (wt && wtName) ctx[wtName] = wt;

  for (const raw of candidates) {
    try {
      const value = evaluateWithContext(normalizeForEval(raw), ctx);
      if (isCostMap(value)) return value;
    } catch {
      // try next enclosing span
    }
  }

  throw new Error("Could not evaluate cost data map");
}

export function buildCostMap(costs: Record<string, CostEntry[]>): Map<string, CostEntry> {
  const map = new Map<string, CostEntry>();
  for (const arr of Object.values(costs)) {
    for (const entry of arr) {
      const colonIdx = entry.id.indexOf(":");
      const bareId = colonIdx >= 0 ? entry.id.slice(colonIdx + 1) : entry.id;
      map.set(bareId, entry);
    }
  }
  return map;
}

export function buildModelEntry(
  entry: SnEntry,
  costMap: Map<string, CostEntry>,
): ModelEntry | null {
  const provider = entry.provider || "unknown";
  const tier = TIER_MAP[provider] ?? "open-source";

  const costEntry = costMap.get(entry.id);
  let cost: { input: number; output: number; cache_read?: number; cache_write?: number };
  if (costEntry) {
    cost = {
      input: costEntry.promptCost,
      output: costEntry.completionCost,
    };
    if (costEntry.cacheHitCost > 0) cost.cache_read = costEntry.cacheHitCost;
    if (costEntry.cacheWrite5mCost > 0) cost.cache_write = costEntry.cacheWrite5mCost;
  } else {
    // ponytail: sync fills real prices (docs → free $0 → models.dev); this is only the unmatched placeholder
    cost = { input: 0.5, output: 2 };
  }

  const fallback = FALLBACK_LIMITS[entry.id];
  const limit = {
    context: entry.contextWindow ?? fallback?.context ?? 200000,
    output: entry.maxOutputTokens ?? fallback?.output ?? 65536,
  };

  const efforts = entry.reasoningEfforts?.length ? [...entry.reasoningEfforts] : undefined;
  const input = entry.inputModalities?.filter((x) => typeof x === "string") ?? [];
  const fromCli =
    input.length > 0
      ? {
          attachment: input.includes("image"),
          modalities: { input: [...input], output: ["text"] },
        }
      : {};

  return {
    id: entry.id,
    name: entry.name,
    tier,
    reasoning: entry.reasoning || (efforts?.length ?? 0) > 0,
    ...(efforts ? { reasoningEfforts: efforts } : {}),
    tool_call: true,
    cost,
    limit,
    ...fromCli,
  };
}

export function disambiguateModelNames(entries: ModelEntry[]): ModelEntry[] {
  const groups = new Map<string, ModelEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.name) ?? [];
    group.push(entry);
    groups.set(entry.name, group);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const entry of group) {
      const suffix = entry.id.split("/").pop() ?? entry.id;
      const normalized = suffix.replace(/[-_]/g, " ");
      if (normalized.toLowerCase().includes("free")) {
        entry.name = `${entry.name} Free`;
      } else if (normalized.toLowerCase() !== entry.name.toLowerCase()) {
        entry.name = `${entry.name} (${suffix})`;
      }
    }
  }

  return entries;
}

export function sortModelEntries(entries: ModelEntry[]): ModelEntry[] {
  disambiguateModelNames(entries);
  return entries.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "premium" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function loadCatalogFromBundle(source: string): ModelEntry[] {
  const models = extractModelCatalog(source);
  let costMap = new Map<string, CostEntry>();
  try {
    costMap = buildCostMap(extractCostData(source));
  } catch {
    // ponytail: CLI cost map is optional; buildModelEntry uses unmatched placeholder until sync fills prices
  }

  const entries: ModelEntry[] = [];
  for (const model of Object.values(models)) {
    if (!model || typeof model !== "object" || typeof model.id !== "string") continue;
    const entry = buildModelEntry(model, costMap);
    if (entry) entries.push(entry);
  }

  for (const extra of HARDCODED_EXTRAS) {
    if (!entries.some((e) => e.id === extra.id)) {
      const entry = buildModelEntry(extra, costMap);
      if (entry) entries.push(entry);
    }
  }

  return sortModelEntries(entries);
}

function readPackageMeta(root: string): { version: string; bundlePath: string } | null {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      version?: string;
      module?: string;
      main?: string;
      bin?: string | Record<string, string>;
      exports?: unknown;
    };

    const binPaths: string[] = [];
    if (typeof pkg.bin === "string") binPaths.push(join(root, pkg.bin));
    else if (pkg.bin && typeof pkg.bin === "object") {
      for (const rel of Object.values(pkg.bin)) {
        if (typeof rel === "string") binPaths.push(join(root, rel));
      }
    }

    // Prefer the full CLI bundle. Newer command-code ships dist/index.mjs as a
    // tiny re-export stub; the catalog lives in dist/cli.mjs (or bin target).
    const candidates = [
      join(root, "dist", "cli.mjs"),
      ...binPaths,
      join(root, "dist", "index.mjs"),
      pkg.module ? join(root, pkg.module) : "",
      pkg.main ? join(root, pkg.main) : "",
    ].filter(Boolean);

    let best: { path: string; size: number } | null = null;
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      try {
        const size = statSync(candidate).size;
        // Skip tiny launcher stubs (< 4KB) that only re-export another file
        if (size < 4096) continue;
        if (!best || size > best.size) best = { path: candidate, size };
      } catch {
        // ignore unreadable candidate
      }
    }

    if (best) {
      return { version: pkg.version ?? "unknown", bundlePath: best.path };
    }
  } catch {
    return null;
  }
  return null;
}

function asPackageRoot(path: string): ResolvedCommandCodePackage | null {
  const resolved = resolvePath(path);
  if (!existsSync(resolved)) return null;

  // Allow pointing at a file; still prefer the full CLI bundle under the package root
  if (resolved.endsWith(".mjs") || resolved.endsWith(".js")) {
    const root = dirname(dirname(resolved));
    const meta = readPackageMeta(root);
    if (meta) return { root, bundlePath: meta.bundlePath, version: meta.version };
    try {
      if (statSync(resolved).size >= 4096) {
        return { root, bundlePath: resolved, version: "unknown" };
      }
    } catch {
      return null;
    }
    return null;
  }

  const meta = readPackageMeta(resolved);
  if (!meta) return null;
  return { root: resolved, bundlePath: meta.bundlePath, version: meta.version };
}

function tryRequireResolve(): ResolvedCommandCodePackage | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve(`${NPM_PACKAGE}/package.json`);
    return asPackageRoot(dirname(pkgJson));
  } catch {
    // try resolving from cwd
  }
  try {
    const require = createRequire(join(process.cwd(), "package.json"));
    const pkgJson = require.resolve(`${NPM_PACKAGE}/package.json`);
    return asPackageRoot(dirname(pkgJson));
  } catch {
    return null;
  }
}

function walkNodeModules(startDir: string): ResolvedCommandCodePackage | null {
  let dir = resolvePath(startDir);
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, "node_modules", NPM_PACKAGE);
    const found = asPackageRoot(candidate);
    if (found) return found;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function tryNpmRootGlobal(): ResolvedCommandCodePackage | null {
  try {
    const root = execSync("npm root -g", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    if (!root) return null;
    return asPackageRoot(join(root, NPM_PACKAGE));
  } catch {
    return null;
  }
}

function tryWindowsAppData(): ResolvedCommandCodePackage | null {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  return asPackageRoot(join(appData, "npm", "node_modules", NPM_PACKAGE));
}

export function resolveCommandCodePackage(options?: {
  packagePath?: string;
}): ResolvedCommandCodePackage | null {
  const explicit =
    options?.packagePath?.trim() || process.env.COMMANDCODE_PACKAGE_PATH?.trim() || "";

  if (explicit) {
    const found = asPackageRoot(explicit);
    if (found) return found;
  }

  return (
    tryRequireResolve() ||
    walkNodeModules(process.cwd()) ||
    tryNpmRootGlobal() ||
    tryWindowsAppData() ||
    null
  );
}

export function loadCatalogFromLocalCommandCode(options?: {
  packagePath?: string;
}): LocalCatalogResult | null {
  try {
    const resolved = resolveCommandCodePackage(options);
    if (!resolved) return null;
    const source = readFileSync(resolved.bundlePath, "utf-8");
    const models = loadCatalogFromBundle(source);
    if (models.length === 0) return null;
    return { models, version: resolved.version, root: resolved.root, bundleSource: source };
  } catch {
    return null;
  }
}

export function toConfigKey(id: string): string {
  const slashIdx = id.indexOf("/");
  const short = slashIdx >= 0 ? id.slice(slashIdx + 1) : id;
  return short.toLowerCase();
}

export function generateOpencodeModels(entries: ModelEntry[]): Record<string, unknown> {
  const models: Record<string, unknown> = {};
  for (const entry of entries) {
    const key = toConfigKey(entry.id);
    const costObj: Record<string, number> = { input: entry.cost.input, output: entry.cost.output };
    if (entry.cost.cache_read !== undefined) costObj.cache_read = entry.cost.cache_read;
    if (entry.cost.cache_write !== undefined) costObj.cache_write = entry.cost.cache_write;

    const model: Record<string, unknown> = {
      id: entry.id,
      name: entry.name,
      reasoning: entry.reasoning,
      tool_call: entry.tool_call,
      attachment: entry.attachment ?? false,
      modalities: entry.modalities ?? { input: ["text"], output: ["text"] },
      cost: costObj,
      limit: entry.limit,
    };

    if (entry.reasoningEfforts && entry.reasoningEfforts.length > 0) {
      model.reasoningEfforts = entry.reasoningEfforts;
      const variants: Record<string, Record<string, unknown>> = {};
      for (const effort of entry.reasoningEfforts) {
        variants[effort] = { reasoningEffort: effort };
      }
      model.variants = variants;
    }

    models[key] = model;
  }
  return models;
}
