import { createContext, useContext } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { MarkdownLink, type MarkdownLinkProps } from "@/modules/markdown/MarkdownLink";
import { currentWorkspaceEnv } from "@/modules/workspace";

const PREFIX = "https://codev-file.invalid/";
export const FileLinkContext = createContext<{ cwd: string; onOpenFile?: (path: string) => void }>({ cwd: "" });
type LinkNode = { type: string; url?: string; children?: LinkNode[] };
/** 在 Markdown 安全过滤前将本地目标编码为内部链接，保留外链原有处理。 */
export function localFileLinks() {
  return (tree: LinkNode) => {
    /** 遍历链接和引用定义，不改写代码块或消息正文。 */
    const visit = (node: LinkNode) => {
      if ((node.type === "link" || node.type === "definition") && node.url) {
        const url = node.url;
        if (/^(?:file:|[a-z]:[\\/]|\/{1,2}|\.\.?[\\/])/i.test(url) || (!/^[\w+.-]+:|^#/.test(url) && /[./\\]/.test(url)))
          node.url = PREFIX + encodeURIComponent(url);
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
/** 本地文件交给主阅读器，文件夹交给系统文件管理器；网页仍走默认浏览器。 */
export function CodexFileLink(props: MarkdownLinkProps) {
  const { cwd, onOpenFile } = useContext(FileLinkContext);
  if (!props.href?.startsWith(PREFIX)) return <MarkdownLink {...props} />;
  const target = decodeURIComponent(props.href.slice(PREFIX.length));
  /** 解析文件链接并按实际类型打开，不让 WebView 导航到本地文件。 */
  const open = async () => {
    try {
      let path = decodeURIComponent(target).replace(/^file:\/\//i, "").replace(/^\/([a-z]:[\\/])/i, "$1").replace(/#(?:L)?\d+(?:C\d+)?$|:\d+(?::\d+)?$/i, "");
      if (!/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(path)) path = `${cwd}/${path}`;
      const stat = await invoke<{ kind: string }>("fs_stat", { path, workspace: currentWorkspaceEnv() });
      if (stat.kind === "dir") await openPath(path);
      else if (onOpenFile) onOpenFile(path);
      else await revealItemInDir(path);
    } catch (error) { toast.error(String(error)); }
  };
  return <MarkdownLink {...props} className={`codex-file-link ${props.className ?? ""}`} href={props.href} title={target} onClick={event => { event.preventDefault(); void open(); }} />;
}
