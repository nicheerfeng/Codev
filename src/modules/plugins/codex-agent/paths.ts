/** 统一 Windows 项目路径比较。 */
export function pathKey(path: string) {
  return path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}
/** 提取项目文件夹名。 */
export function projectName(path: string) {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}
