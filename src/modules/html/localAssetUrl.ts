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

/** 只改写会加载的本地资源；导航锚点改成页内哈希。 */
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
  let next = neutralizeSrcdocAnchors(withSrcdocBase(html));
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
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (full, quote: string, url: string) => {
      if (isRemoteAssetUrl(url.trim())) return full;
      return `url(${quote}${rewrite(url.trim())}${quote})`;
    },
  );
}
