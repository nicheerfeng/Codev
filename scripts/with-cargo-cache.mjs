import { accessSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [tool, ...args] = process.argv.slice(2);
if (tool !== "tauri" && tool !== "cargo") {
  throw new Error("Usage: with-cargo-cache.mjs <tauri|cargo> [args...]");
}

/** 按当前机器选择可写的仓库外缓存，兼容不同用户、盘符和系统。 */
function resolveCargoCache() {
  const platformCache = process.platform === "win32"
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches")
      : process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  const candidates = [
    process.env.CODEV_CARGO_TARGET_DIR,
    process.env.CARGO_TARGET_DIR,
    path.join(platformCache, "codev-cargo-target"),
  ];
  for (const candidate of new Set(candidates.filter(Boolean))) {
    const target = path.resolve(candidate);
    const relative = path.relative(root, target);
    if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) {
      console.warn("[Codev] 跳过仓库内缓存：" + target);
      continue;
    }
    try {
      mkdirSync(target, { recursive: true });
      accessSync(target, constants.W_OK);
      return target;
    } catch (error) {
      console.warn("[Codev] 缓存不可用，尝试下一路径：" + target + " (" + error.message + ")");
    }
  }
  throw new Error("没有可写的仓库外 Rust 缓存目录。");
}

const target = resolveCargoCache();
const env = { ...process.env, CARGO_TARGET_DIR: target };
const configDir = path.join(root, "src-tauri", ".cargo");
mkdirSync(configDir, { recursive: true });
writeFileSync(
  path.join(configDir, "config.toml"),
  "# 本机自动生成，不进 Git。由 scripts/with-cargo-cache.mjs 自动解析缓存目录。\n[build]\ntarget-dir = " + JSON.stringify(target) + "\n",
);
console.log("[Codev] CARGO_TARGET_DIR=" + target);

const require = createRequire(import.meta.url);
const command = tool === "tauri" ? process.execPath : process.platform === "win32" ? "cargo.exe" : "cargo";
const commandArgs = tool === "tauri"
  ? [path.join(path.dirname(require.resolve("@tauri-apps/cli")), "tauri.js"), ...args]
  : args;
const child = spawn(command, commandArgs, {
  cwd: tool === "cargo" ? path.join(root, "src-tauri") : root,
  env,
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
