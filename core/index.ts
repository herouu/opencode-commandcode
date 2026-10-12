// core/ 是与插件版本无关的业务逻辑（不 import V1 / V2 任一 SDK 类型）。
// V1 adapter（plugin/v1.ts）与 V2 adapter（plugin/v2.ts）都只通过这里复用逻辑。
export {
  DEFAULT_BASE_URL,
  DEFAULT_REMOTE_CATALOG_URL,
  ensureProviderBlock,
  loadPluginConfig,
  resolveCatalogUrl,
  resolvePackagePathOverride,
} from "./config.js";
export type { PluginFileConfig } from "./config.js";
export { resolveCatalog } from "./source.js";
export type { CatalogResolution, ResolveCatalogOptions } from "./source.js";
export { buildStartupSummary, persistCatalogCache, persistStartupSummary } from "./sync.js";
