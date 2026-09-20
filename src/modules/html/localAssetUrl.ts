/** 把 HTML 相对资源解析成本地绝对路径，并编成与 Tauri convertFileSrc 一致的 asset URL。 */

const REMOTE = /^(https?:|data:|blob:|javascript:|mailto:|vscode:)/i;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/** 统一成正斜杠路径，去掉 file:// 和 Windows \\?\ 前缀。 */
export function normalizeFsPath(path: string): string {
  let value = path.trim();
  if (/^file:\/\//i.test(value)) {
    value = decodeURIComponent(value.replace(/^file:\/\//i, ""));
    if (/^\/[A-Za-z]:/.test(value)) value = value.slice(1);
  }
  value = value.replace(/\\/g, "/");
  if (value.startsWith("//?/")) value = value.slice(4);
  if (value.startsWith("//")) value = value.slice(1);
  return value.replace(/\/+$/, "") || value;
}

/** HTML 文件所在目录。 */
export function parentDirectory(path: string): string {
  const normalized = normalizeFsPath(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? normalized : normalized.slice(0, index);
}

/** 远程或内嵌地址不改写。 */
export function isRemoteAssetUrl(url: string): boolean {
  const value = url.trim();
  return !value || value.startsWith("#") || REMOTE.test(value);
}

/** 按 POSIX 规则拼接并解析 `.` / `..`。 */
export function joinFsPath(baseDir: string, relative: string): string {
  const root = normalizeFsPath(baseDir);
  const drive = WINDOWS_DRIVE.test(root) ? root.slice(0, 2) : "";
  const rootBody = drive ? root.slice(2) : root;
  const parts = rootBody.split("/").filter(Boolean);
  for (const segment of relative.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  if (drive) return `${drive}/${parts.join("/")}`;
  return root.startsWith("/") ? `/${parts.join("/")}` : parts.join("/");
}

/**
 * 把 HTML 里的 src/href 解析成磁盘绝对路径。
 * 浏览器打开 file:// 时，`/a.png` 落在盘符根目录，这里保持同一语义。
 */
export function resolveHtmlAssetPath(
  htmlPath: string,
  rawUrl: string,
): string | null {
  const url = rawUrl.trim().replace(/^['"]|['"]$/g, "");
  if (isRemoteAssetUrl(url)) return null;
  const html = normalizeFsPath(htmlPath);
  const dir = parentDirectory(html);
  if (WINDOWS_DRIVE.test(url)) return normalizeFsPath(url);
  if (/^file:/i.test(url)) return normalizeFsPath(url);
  if (url.startsWith("/")) {
    if (WINDOWS_DRIVE.test(html)) return `${html.slice(0, 2)}${url}`;
    return url;
  }
  return joinFsPath(dir, url);
}

/** 与 Windows 上 convertFileSrc 一致：盘符路径用反斜杠，整条路径编成一个 URL 段。 */
export function nativeFsPath(path: string): string {
  const normalized = normalizeFsPath(path);
  return /^[A-Za-z]:\//.test(normalized)
    ? normalized.replace(/\//g, "\\")
    : normalized;
}

/** srcdoc 里会把 iframe 导航到父页 Codev 的相对地址。 */
export function isSrcdocEscapeHref(url: string): boolean {
  const value = url.trim();
  if (value.startsWith("#")) return false;
  if (REMOTE.test(value)) return false;
  return true;
}

/** 只改 script 标签以外的标记，避免改写 Pi 导出里的 JS。 */
export function mapMarkupOutsideScripts(
  html: string,
  map: (markup: string) => string,
): string {
  const parts: string[] = [];
  const script = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
  let last = 0;
  for (const match of html.matchAll(script)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(map(html.slice(last, index)));
    parts.push(match[0]);
    last = index + match[0].length;
  }
  if (last < html.length) parts.push(map(html.slice(last)));
  return parts.join("");
}

/** 含执行脚本的页面使用独立文档，避免 srcdoc 继承父页 CSP 阻断初始化。 */
export function htmlNeedsAssetDocument(html: string): boolean {
  const script = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(script)) {
    const attrs = match[1] ?? "";
    if (/\btype\s*=\s*["']application\/(?:ld\+)?json["']/i.test(attrs)) {
      continue;
    }
    if (/\bsrc\s*=/i.test(attrs) || match[2].trim()) return true;
  }
  return false;
}

/** 保留文档目录层级，让动态 script、fetch 和相对资源按真实文件目录解析。 */
export function htmlDocumentUrl(
  path: string,
  toSrc: (path: string) => string,
): string {
  return `${toSrc(nativeFsPath(path)).replace(/%2f|%5c/gi, "/")}?codev-preview=1`;
}

/** 相对/空锚点改成页内哈希，避免 srcdoc 打开 Codev。 */
export function neutralizeSrcdocAnchors(html: string): string {
  return html.replace(
    /<a\b([^>]*?)\bhref\s*=\s*(["'])([^"']*)\2/gi,
    (full, before: string, quote: string, url: string) => {
      if (!isSrcdocEscapeHref(url)) return full;
      const hashIndex = url.indexOf("#");
      const hash = hashIndex >= 0 ? url.slice(hashIndex) : "#";
      return `<a${before}href=${quote}${hash || "#"}${quote}`;
    },
  );
}

/** srcdoc 没有自己的目录，相对地址会落到父页 Codev；先钉死基址。 */
export function withSrcdocBase(html: string): string {
  if (/<base\b/i.test(html)) return html;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(
      /<head[^>]*>/i,
      (open) => `${open}<base href="about:srcdoc">`,
    );
  }
  return `<base href="about:srcdoc">${html}`;
}

function rewriteMarkupAssets(
  html: string,
  rewrite: (raw: string) => string,
): string {
  let next = neutralizeSrcdocAnchors(html);
  next = next.replace(
    /\b(src|poster)\s*=\s*(["'])([^"']*)\2/gi,
    (full, attr: string, quote: string, url: string) => {
      if (isRemoteAssetUrl(url)) return full;
      return `${attr}=${quote}${rewrite(url)}${quote}`;
    },
  );
  next = next.replace(
    /<link\b([^>]*?)\bhref\s*=\s*(["'])([^"']*)\2/gi,
    (full, before: string, quote: string, url: string) => {
      if (isRemoteAssetUrl(url)) return full;
      return `<link${before}href=${quote}${rewrite(url)}${quote}`;
    },
  );
  next = next.replace(
    /\bsrcset\s*=\s*(["'])([^"']*)\1/gi,
    (_full, quote: string, value: string) => {
      const rewritten = value
        .split(",")
        .map((part) => {
          const trimmed = part.trim();
          const match = trimmed.match(/^(\S+)(\s+.*)?$/);
          if (!match || isRemoteAssetUrl(match[1])) return part;
          return `${rewrite(match[1])}${match[2] ?? ""}`;
        })
        .join(", ");
      return `srcset=${quote}${rewritten}${quote}`;
    },
  );
  return next.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/g,
    (full, quote: string, url: string) => {
      if (isRemoteAssetUrl(url.trim())) return full;
      return `url(${quote}${rewrite(url.trim())}${quote})`;
    },
  );
}

/** 只改写标记里的本地资源，不改 <script> 源码。 */
export function rewriteHtmlLocalAssets(
  html: string,
  htmlPath: string,
  toSrc: (absPath: string) => string,
): string {
  const rewrite = (raw: string) => {
    const resolved = resolveHtmlAssetPath(htmlPath, raw);
    if (!resolved) return raw;
    return toSrc(nativeFsPath(resolved));
  };
  return mapMarkupOutsideScripts(withSrcdocBase(html), (markup) =>
    rewriteMarkupAssets(markup, rewrite),
  );
}
