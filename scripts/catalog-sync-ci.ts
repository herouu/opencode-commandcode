#!/usr/bin/env bun
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { catalogBreakTitle, renderCatalogBreakBody } from "../src/catalog-break.js";
import {
  lastSuccessfulModelCount,
  meetsModelCountFloor,
  type CatalogManifest,
} from "../src/manifest.js";
import { npmLatestVersion } from "./npm-registry.js";

const ROOT = join(import.meta.dir, "..");
const CATALOG_FILES = ["models.json", "_version.txt", "manifest.json"];

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function bundledCommandCodeVersion(): string | null {
  const path = join(ROOT, "_version.txt");
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8").split("\n")[0]?.trim() || null;
}

function git(args: string): string {
  return execSync(`git ${args}`, { cwd: ROOT, encoding: "utf-8" }).trim();
}

function openOrUpdateCatalogBreak(input: { commandCodeVersion: string; error: string }): void {
  const title = catalogBreakTitle(input.commandCodeVersion);
  const body = renderCatalogBreakBody({
    commandCodeVersion: input.commandCodeVersion,
    error: input.error,
    workflowUrl:
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : "(local)",
    bundledCommandCodeVersion: bundledCommandCodeVersion(),
  });
  const existing = execSync(
    `gh issue list --label catalog-break --state open --json number,title`,
    { cwd: ROOT, encoding: "utf-8" },
  );
  const issues = JSON.parse(existing) as Array<{ number: number; title: string }>;
  if (issues.length === 0) {
    execSync(
      `gh issue create --title ${JSON.stringify(title)} --body ${JSON.stringify(body)} --label catalog-break --label automation`,
      {
        cwd: ROOT,
        stdio: "inherit",
      },
    );
    return;
  }
  execSync(`gh issue comment ${issues[0].number} --body ${JSON.stringify(body)}`, {
    cwd: ROOT,
    stdio: "inherit",
  });
}

// 路线 A（gfwlist 式直推）：不开 PR、不依赖 semantic-release 发版。
// catalog 文件直接提交到当前分支（main）并推送，插件运行时从 raw URL 拉取即生效。
function pushToMain(commandCodeVersion: string): void {
  const status = git(`status --porcelain -- ${CATALOG_FILES.join(" ")}`);
  if (!status) {
    console.log("catalog files unchanged");
    return;
  }
  git('config user.name "github-actions[bot]"');
  git('config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
  execSync(`git add ${CATALOG_FILES.join(" ")}`, { cwd: ROOT, stdio: "inherit" });
  execSync(
    `git commit -m ${JSON.stringify(`models.json edited ${new Date().toUTCString()} (command-code@${commandCodeVersion})`)}`,
    { cwd: ROOT, stdio: "inherit" },
  );
  execSync(`git push origin HEAD:main`, { cwd: ROOT, stdio: "inherit" });
  console.log(`pushed catalog sync for command-code@${commandCodeVersion} to main`);
}

async function main(): Promise<void> {
  const force = process.env.FORCE === "true" || process.argv.includes("--force");
  const latestCc = await npmLatestVersion("command-code");

  // 路线 A：不依赖 npm 发布状态。仅当上游 command-code 版本变化（或 force）才重新提取。
  const shouldExtract = force || latestCc !== bundledCommandCodeVersion();

  console.log(
    JSON.stringify({
      latestCc,
      bundledCommandCodeVersion: bundledCommandCodeVersion(),
      shouldExtract,
    }),
  );

  if (!shouldExtract) {
    console.log("catalog up to date, no extract needed");
    return;
  }

  const prior = readJson<CatalogManifest>(join(ROOT, "manifest.json"));
  const beforeModels = existsSync(join(ROOT, "models.json"))
    ? readFileSync(join(ROOT, "models.json"), "utf-8")
    : "";
  const beforeVersion = bundledCommandCodeVersion();

  try {
    execSync("bun run scripts/sync-models.ts -- --remote", { cwd: ROOT, stdio: "inherit" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      openOrUpdateCatalogBreak({ commandCodeVersion: latestCc, error: message });
    } catch (issueErr) {
      console.error("failed to open catalog-break issue", issueErr);
    }
    process.exitCode = 1;
    return;
  }

  const afterModels = readFileSync(join(ROOT, "models.json"), "utf-8");
  const entries = JSON.parse(afterModels) as unknown[];
  const lastCount = lastSuccessfulModelCount(prior);
  if (!meetsModelCountFloor(entries.length, lastCount)) {
    const message = `model count ${entries.length} below floor (lastSuccessful=${lastCount})`;
    try {
      openOrUpdateCatalogBreak({ commandCodeVersion: latestCc, error: message });
    } catch (issueErr) {
      console.error("failed to open catalog-break issue", issueErr);
    }
    execSync(`git checkout -- ${CATALOG_FILES.join(" ")}`, { cwd: ROOT, stdio: "inherit" });
    process.exitCode = 1;
    return;
  }

  const changed = afterModels !== beforeModels || bundledCommandCodeVersion() !== beforeVersion;
  if (!changed) {
    console.log("extract produced no catalog changes");
    return;
  }

  if (process.env.CI === "true") {
    pushToMain(bundledCommandCodeVersion() ?? latestCc);
  } else {
    console.log("catalog updated locally; set CI=true to push to main");
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
