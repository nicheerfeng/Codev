/** 将命中指定路径前缀的绝对路径重定位到新前缀。 */
export function replacePathPrefix(
  path: string,
  from: string,
  to: string,
): string {
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedFrom = from.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedTo = to.replace(/\\/g, "/").replace(/\/+$/, "");
  const windowsPath = /^[A-Za-z]:\//.test(normalizedPath);
  const candidate = windowsPath ? normalizedPath.toLowerCase() : normalizedPath;
  const prefix = windowsPath ? normalizedFrom.toLowerCase() : normalizedFrom;
  if (candidate === prefix) return normalizedTo;
  if (!candidate.startsWith(`${prefix}/`)) return normalizedPath;
  return `${normalizedTo}${normalizedPath.slice(normalizedFrom.length)}`;
}
