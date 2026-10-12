import { resolveApiKey } from "./src/auth.js";
import { CommandCodeLanguageModel } from "./src/model.js";

export interface CommandCodeProviderOptions {
  name?: string;
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  authPaths?: string[];
}

export function createCommandCode(options: CommandCodeProviderOptions = {}) {
  const apiKey = resolveApiKey({ apiKey: options.apiKey, authPaths: options.authPaths });
  if (!apiKey) {
    throw new Error(
      "Command Code API key not found. Set COMMANDCODE_API_KEY env var, create ~/.commandcode/auth.json, or pass apiKey option.",
    );
  }

  return {
    languageModel(modelId: string): CommandCodeLanguageModel {
      return new CommandCodeLanguageModel(modelId, {
        apiKey,
        baseURL: typeof options.baseURL === "string" ? options.baseURL : undefined,
        headers:
          typeof options.headers === "object" && options.headers !== null
            ? (options.headers as Record<string, string>)
            : undefined,
      });
    },
  };
}

// one-package 双版本插件入口的组合薄壳：V2 的 { id, setup } 与 V1 的 { server() }。
// opencode v2 解析本地目录插件时先试 `server.*` 再试 `index.*`，`plugin/index.ts` 不是自动候选，
// 所以必须由本文件（package main）把同一个组合对象作为 default 再导出一次。
// 单独使用 createCommandCode（AI SDK provider 路径）的消费者不会执行插件逻辑。
export { default } from "./plugin/index.js";
export { default as commandcodePlugin } from "./plugin/index.js";
