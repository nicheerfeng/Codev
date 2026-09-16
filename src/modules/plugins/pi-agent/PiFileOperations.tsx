import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { collectFileOperations, type FileOperation } from "./fileOperations";
import type { PiTranscriptItem } from "./types";

/** 展示本轮已识别文件操作；点击在主界面打开，不加入工作区根目录。 */
export function PiFileOperations({
  items,
  cwd,
  onOpenFile,
}: {
  items: PiTranscriptItem[];
  cwd: string;
  onOpenFile?: (path: string) => void;
}) {
  const files = collectFileOperations(items, cwd);
  if (!files.length) return null;
  /** 已删除文件定位父目录，无法定位时提示具体错误。 */
  async function reveal(file: FileOperation) {
    try {
      await revealItemInDir(
        file.operation === "删除"
          ? file.path.slice(0, file.path.lastIndexOf("/")) + "/"
          : file.path,
      );
    } catch (error) {
      toast.error("无法定位文件或目录", { description: String(error) });
    }
  }
  function openFile(file: FileOperation) {
    if (file.operation === "删除" || !onOpenFile) {
      void reveal(file);
      return;
    }
    onOpenFile(file.path);
  }
  return (
    <details className="my-1 min-w-0 text-xs text-muted-foreground">
      <summary className="cursor-pointer py-1 leading-6 [overflow-wrap:anywhere]">
        修改观测 · {files.length} 个文件：
        {files.map((file) => file.path.split("/").pop()).join("、")}
      </summary>
      <div className="space-y-1 py-1 pl-4">
        {files.map((file) => (
          <div key={file.path} className="flex items-start gap-1">
            <button
              type="button"
              title="在主界面打开"
              className="min-w-0 flex-1 text-left leading-5 hover:text-foreground [overflow-wrap:anywhere]"
              onClick={() => openFile(file)}
            >
              {file.operation} · {file.path}
            </button>
            <button
              type="button"
              title="在资源管理器中显示"
              aria-label={`在资源管理器中显示 ${file.path.split("/").pop()}`}
              className="shrink-0 px-1 leading-5 hover:text-foreground"
              onClick={() => void reveal(file)}
            >
              ↗
            </button>
          </div>
        ))}
      </div>
    </details>
  );
}
