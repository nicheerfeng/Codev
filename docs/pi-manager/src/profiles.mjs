import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { normalizeName } from './common.mjs';

const LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** 解析严格 JSON agent profile，拒绝未知资源字段和无效 thinking。 */
export function parseProfile(text, fallbackName, source, scope) {
  const attrs = JSON.parse(text);
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) throw new Error(`${source}: profile 必须是 JSON 对象`);
  const allowed = new Set(['name', 'description', 'provider', 'model', 'thinking', 'tools', 'prompt']);
  for (const key of Object.keys(attrs)) if (!allowed.has(key)) throw new Error(`${source}: 不支持字段 ${key}`);
  const alias = normalizeName(attrs.name || fallbackName);
  if ((attrs.provider && !attrs.model) || (attrs.model && !attrs.provider)) throw new Error(`${source}: provider/model 必须成对出现`);
  return {
    alias, description: typeof attrs.description === 'string' ? attrs.description : '', provider: attrs.provider, model: attrs.model,
    thinking: LEVELS.has(attrs.thinking) ? attrs.thinking : undefined,
    tools: Array.isArray(attrs.tools) ? attrs.tools.filter(value => typeof value === 'string') : undefined,
    prompt: typeof attrs.prompt === 'string' ? attrs.prompt.trim() : '', source, scope,
  };
}

/** 扫描单个 profile 目录，错误只影响当前文件。 */
function readDirectory(directory, scope) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return { profiles: [], errors: [] };
  const profiles = [], errors = [];
  for (const file of readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
    const source = join(directory, file);
    try { profiles.push(parseProfile(readFileSync(source, 'utf8'), file.slice(0, -3), source, scope)); }
    catch (error) { errors.push({ source, error: String(error.message ?? error) }); }
  }
  return { profiles, errors };
}

/** 合并公共 profile 与当前 cwd 向上继承的项目 profile，近项目覆盖远项目和公共定义。 */
export function discoverProfiles(agentDir, cwd) {
  const merged = new Map(), errors = [];
  const global = readDirectory(join(agentDir, 'pi-manager', 'agents'), 'global');
  for (const profile of global.profiles) merged.set(profile.alias, profile);
  errors.push(...global.errors);
  const directories = [];
  let current = resolve(cwd);
  while (true) {
    directories.unshift(join(current, '.agent', 'agents'));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const directory of directories) {
    const result = readDirectory(directory, 'project');
    for (const profile of result.profiles) merged.set(profile.alias, profile);
    errors.push(...result.errors);
  }
  return { profiles: [...merged.values()].sort((a, b) => a.alias.localeCompare(b.alias)), errors };
}

/** 用 alias 解析 provider/model/thinking/prompt 的一次性 spawn 快照。 */
export function resolveProfile(profiles, alias, requested = {}) {
  if (!alias) return { ...requested };
  const profile = profiles.find(item => item.alias === alias);
  if (!profile) throw new Error(`未知 agent profile: ${alias}`);
  if (requested.provider && requested.provider !== profile.provider) throw new Error('requested provider 与 profile 不一致');
  if (requested.model?.id && requested.model.id !== profile.model) throw new Error('requested model 与 profile 不一致');
  return {
    ...requested, profileAlias: profile.alias, provider: profile.provider ?? requested.provider,
    model: profile.model ? { provider: profile.provider, id: profile.model } : requested.model,
    thinking: profile.thinking ?? requested.thinking, tools: profile.tools ?? requested.tools,
    prompt: [profile.prompt, requested.prompt].filter(Boolean).join('\n\n'),
  };
}
