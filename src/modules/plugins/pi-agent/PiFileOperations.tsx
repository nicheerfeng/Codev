import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { collectFileOperations, type FileOperation } from "./fileOperations";
import type { PiTranscriptItem } from "./types";

/** 展示本轮已识别文件操作，展开完整路径并在资源管理器中定位。 */
export function PiFileOperations({
  items,
  cwd,
}: {
  items: PiTranscriptItem[];
  cwd: string;
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
  return (
    <details className="my-1 min-w-0 text-xs text-muted-foreground">
      <summary className="cursor-pointer py-1 leading-6 [overflow-wrap:anywhere]">
        修改观测 · {files.length} 个文件：
        {files.map((file) => file.path.split("/").pop()).join("、")}
      </summary>
      <div className="space-y-1 py-1 pl-4">
        {files.map((file) => (
          <button
            key={file.path}
            type="button"
            title="在资源管理器中定位"
            className="block w-full text-left leading-5 hover:text-foreground [overflow-wrap:anywhere]"
            onClick={() => void reveal(file)}
          >
            {file.operation} · {file.path} ↗
          </button>
        ))}
      </div>
    </details>
  );
}
