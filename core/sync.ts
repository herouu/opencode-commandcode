import { pluginStateDir, writeCatalogCache, writeStartupSummary } from "../src/startup.js";
import type { StartupSummary } from "../src/startup.js";
import type { CatalogResolution } from "./source.js";

/**
 * 目录缓存落盘：只有 models 非空且来源"新鲜"（remote / opt-in-local）才写，
 * 避免把包内冻结快照钉死在缓存里。写失败静默忽略（与 V1/V2 adapter 期望行为一致）。
 */
export function persistCatalogCache(resolution: CatalogResolution): void {
  const { models, cacheableSource, commandCodeVersion } = resolution;
  if (models.length > 0 && cacheableSource) {
    try {
      writeCatalogCache(pluginStateDir(), models, {
        source: cacheableSource,
        commandCodeVersion,
      });
    } catch {
      // 忽略缓存写入失败
    }
  }
}

/** 由目录解析结果构造启动摘要（与插件版本无关）。 */
export function buildStartupSummary(resolution: CatalogResolution): StartupSummary {
  return {
    catalogSource: resolution.catalogSource,
    commandCodeVersion: resolution.commandCodeVersion,
    modelCount: resolution.models.length,
    reasoningModelCount: resolution.models.filter((m) => m.reasoning).length,
    degraded: resolution.degraded,
    degradedReason: resolution.degradedReason,
    catalogGeneratedAt: resolution.catalogGeneratedAt,
  };
}

/** 写启动摘要（失败静默忽略）；debug 打开时额外打印一行 warn。 */
export function persistStartupSummary(summary: StartupSummary, debug: boolean): void {
  try {
    writeStartupSummary(pluginStateDir(), summary);
  } catch {
    // 忽略
  }
  if (debug) {
    console.warn("[commandcode]", JSON.stringify(summary));
  }
}
