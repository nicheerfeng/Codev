export type SkillRef = {
  name: string;
  path: string;
  description?: string;
};

const LOCAL_SLASH = new Set(["compact", "fork", "new", "model", "stop"]);
const MENTION_RE = /\[\$([A-Za-z0-9][A-Za-z0-9_-]*)\]\(([^)\s]+)\)/g;
const DOLLAR_RE = /\$([A-Za-z0-9][A-Za-z0-9_-]*)(?=$|[\s,.;:!?])/g;
const LEADING_SLASH_RE = /^\/(?:skill:)?([A-Za-z0-9][A-Za-z0-9_-]*)(?=\s|$)/iu;

/** 去掉 skill: / $ 前缀，得到展示名。 */
export function skillShortName(name: string): string {
  return name
    .replace(/^skill:/iu, "")
    .replace(/^\$/u, "")
    .trim();
}

/** 技能目录补成 SKILL.md，已是文件则原样返回。 */
export function skillFilePath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  if (!trimmed) return path;
  if (/skill\.md$/iu.test(trimmed)) return trimmed.replace(/\\/g, "/");
  const sep = trimmed.includes("\\") && !trimmed.includes("/") ? "\\" : "/";
  return `${trimmed}${sep}SKILL.md`.replace(/\\/g, "/");
}

function skillKey(name: string): string {
  return skillShortName(name).toLowerCase();
}

function catalogByName(catalog: SkillRef[]): Map<string, SkillRef> {
  const map = new Map<string, SkillRef>();
  for (const skill of catalog) {
    const key = skillKey(skill.name);
    if (key) map.set(key, skill);
  }
  return map;
}

/** 发给模型的内联引用，界面不直接展示路径。 */
export function serializeSkillMention(name: string, path: string): string {
  return `[$${skillShortName(name)}](${skillFilePath(path)})`;
}

/** 斜杠选中后写入输入行：只出现 $name，不出现路径。 */
export function insertSkillToken(text: string, name: string): string {
  const token = `$${skillShortName(name)}`;
  const rest = /^\/[^\s]*$/u.test(text.trim())
    ? ""
    : text.replace(/^\/[^\s]*\s*/u, "").replace(/^\s+/u, "");
  return rest ? `${token} ${rest}` : `${token} `;
}

/** 选中技能：输入行只留 $name，路径放进绑定列表。 */
export function insertSkillMention(
  text: string,
  skill: SkillRef,
  selected: SkillRef[] = [],
): { text: string; skills: SkillRef[] } {
  const name = skillShortName(skill.name);
  const path = skill.path ? skillFilePath(skill.path) : "";
  const next: SkillRef = {
    name,
    path,
    ...(skill.description ? { description: skill.description } : {}),
  };
  return {
    text: insertSkillToken(text, name),
    skills: [
      ...selected.filter((item) => skillKey(item.name) !== skillKey(name)),
      next,
    ],
  };
}

/** 输入行里已经没有的 $name，丢掉对应绑定。 */
export function syncSkillBindings(
  text: string,
  skills: SkillRef[] = [],
): SkillRef[] {
  const names = new Set(
    [...text.matchAll(/\$([A-Za-z0-9][A-Za-z0-9_-]*)/g)].map((match) =>
      match[1].toLowerCase(),
    ),
  );
  return skills.filter((skill) => names.has(skillKey(skill.name)));
}

/** 粘贴进来的 [$name](path) 收成 $name + 绑定，输入框不露路径。 */
export function collapseSkillMentions(
  text: string,
  selected: SkillRef[] = [],
): { text: string; skills: SkillRef[] } {
  const skills = [...selected];
  const seen = new Set(skills.map((skill) => skillKey(skill.name)));
  const next = text.replace(MENTION_RE, (_all, raw: string, path: string) => {
    const name = skillShortName(raw);
    const key = name.toLowerCase();
    if (name && path && !seen.has(key)) {
      seen.add(key);
      skills.push({ name, path: skillFilePath(path) });
    }
    return name ? `$${name}` : _all;
  });
  return { text: next, skills: syncSkillBindings(next, skills) };
}

export type SkillSegment =
  | { kind: "text"; text: string }
  | { kind: "skill"; name: string; path: string };

/** 把 [$name](path) 拆成展示段，气泡只渲染 $name。 */
export function splitSkillMentions(text: string): SkillSegment[] {
  const segments: SkillSegment[] = [];
  const pattern = new RegExp(MENTION_RE.source, "g");
  let last = 0;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    if (match.index > last)
      segments.push({ kind: "text", text: text.slice(last, match.index) });
    segments.push({
      kind: "skill",
      name: match[1] ?? "",
      path: (match[2] ?? "").trim(),
    });
    last = match.index + match[0].length;
    match = pattern.exec(text);
  }
  if (last < text.length)
    segments.push({ kind: "text", text: text.slice(last) });
  if (segments.some((part) => part.kind === "skill"))
    return segments.length ? segments : [{ kind: "text", text }];
  const dollar = new RegExp(DOLLAR_RE.source, "g");
  const fallback: SkillSegment[] = [];
  last = 0;
  match = dollar.exec(text);
  while (match) {
    if (match.index > last)
      fallback.push({ kind: "text", text: text.slice(last, match.index) });
    fallback.push({
      kind: "skill",
      name: match[1] ?? "",
      path: "",
    });
    last = match.index + match[0].length;
    match = dollar.exec(text);
  }
  if (last < text.length)
    fallback.push({ kind: "text", text: text.slice(last) });
  return fallback.length ? fallback : [{ kind: "text", text }];
}

/** 输入行高亮：只给已绑定的 $name 上色，避免误伤普通美元符号。 */
export function skillHighlightSegments(
  text: string,
  skills: SkillRef[] = [],
): Array<{ text: string; skill: boolean }> {
  const names = new Set(skills.map((skill) => skillKey(skill.name)));
  if (!names.size) return [{ text, skill: false }];
  const segments: Array<{ text: string; skill: boolean }> = [];
  const pattern = new RegExp(DOLLAR_RE.source, "g");
  let last = 0;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    const name = match[1] ?? "";
    const bound = names.has(name.toLowerCase());
    if (match.index > last)
      segments.push({ text: text.slice(last, match.index), skill: false });
    segments.push({ text: match[0], skill: bound });
    last = match.index + match[0].length;
    match = pattern.exec(text);
  }
  if (last < text.length)
    segments.push({ text: text.slice(last), skill: false });
  return segments.length ? segments : [{ text, skill: false }];
}

/** 发送/复制前把 $name 收成 [$name](path)。绑定优先于目录。 */
export function expandSkillMentions(
  text: string,
  catalog: SkillRef[] = [],
): string {
  const byName = catalogByName(catalog);
  let rest = text;
  const leading = rest.match(LEADING_SLASH_RE);
  if (leading) {
    const short = skillShortName(leading[1] ?? "");
    if (short && !LOCAL_SLASH.has(short.toLowerCase())) {
      const known = byName.get(short.toLowerCase());
      const token = known
        ? serializeSkillMention(known.name, known.path)
        : `$${short}`;
      rest = `${token}${rest.slice(leading[0].length)}`;
    }
  }
  return rest.replace(DOLLAR_RE, (token, raw: string, offset: number) => {
    if (rest.slice(Math.max(0, offset - 1), offset) === "[") return token;
    const known = byName.get(String(raw).toLowerCase());
    return known ? serializeSkillMention(known.name, known.path) : token;
  });
}
