import type { ReactElement } from "react";
import { toast } from "sonner";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu";

/** 将原始图片转为剪贴板通用 PNG，支持 JPEG、WebP 与本地附件。 */
async function imagePng(src: string): Promise<Blob> {
  const response = await fetch(src);
  if (!response.ok) throw new Error("无法读取图片");
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法转换图片");
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("无法转换图片")), "image/png",
    ));
  } finally {
    bitmap.close();
  }
}

/** 图片右键菜单，复制实际图像而非路径或链接。 */
export function ImageContextMenu({ src, children }: { src: string; children: ReactElement }) {
  /** 在点击时提交剪贴板写入，异步准备 PNG 内容并报告失败。 */
  const copy = () => {
    void navigator.clipboard.write([new ClipboardItem({ "image/png": imagePng(src) })])
      .catch((error) => toast.error(`复制图片失败：${String(error)}`));
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent style={{ zIndex: 2147483647 }}>
        <ContextMenuItem onSelect={copy}>复制图片</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
