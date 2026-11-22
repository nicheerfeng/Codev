// Prepare an isolated, pinned agent adapter. Does not change global CLI configuration.
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const version = "2.6.0";
const platformData = process.platform === "win32"
  ? process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
  : process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support")
    : process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const root = process.env.CODEV_AGENT_TOOLS_DIR || path.join(platformData, "codev-agent-tools");
const directory = path.join(root, `codex-acp-${version}`);
const manifestPath = path.join(directory, "package.json");
const entry = path.join(directory, "node_modules", "@agentclientprotocol", "codex-acp", "dist", "index.js");
const exists = async (name) => access(name, constants.R_OK).then(() => true, () => false);
async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (cause) { throw new Error(`无法读取代理依赖清单：${file}`, { cause }); }
}

if (await exists(entry)) {
  const installed = await readJson(path.join(directory, "node_modules", "@agentclientprotocol", "codex-acp", "package.json"));
  if (installed.version !== version) throw new Error("Managed adapter version does not match its versioned directory.");
  console.log(`Codex ACP ${version} 已准备，使用独立依赖目录。`);
} else {
  await mkdir(directory, { recursive: true });
  const manifest = { private: true, name: "codev-managed-codex-adapter", version: "1.0.0", type: "module", dependencies: { "@agentclientprotocol/codex-acp": version } };
  if (await exists(manifestPath)) {
    const existing = await readJson(manifestPath);
    if (existing.dependencies?.["@agentclientprotocol/codex-acp"] !== version) throw new Error("The managed directory contains a different adapter manifest.");
  } else await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manager = process.env.npm_execpath;
  if (!manager || !/pnpm/i.test(manager)) throw new Error("请通过 pnpm agent:prepare 运行此脚本。");
  const registryArgument = process.argv.slice(2).find((value) => value.startsWith("--registry="));
  const args = [manager, "install", "--prod", "--ignore-scripts", "--no-frozen-lockfile"];
  if (registryArgument) args.push(registryArgument);
  console.log(`准备 Codex ACP ${version}；不会启动代理、登录或发送模型消息。`);
  const child = spawn(process.execPath, args, { cwd: directory, env: process.env, stdio: "inherit", windowsHide: true });
  const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code)); });
  if (result !== 0) throw new Error(`Adapter installation exited with ${result}.`);
  if (!(await exists(entry))) throw new Error("Adapter entry point is missing after installation.");
  console.log(`Codex ACP ${version} 已准备。原生认证与项目配置保持原样。`);
}
