import { forwardRef, memo } from "react";
import { EditorPane, type EditorPaneHandle } from "./EditorPane";
import { FilePreviewPane, getPreviewKind } from "./FilePreviewPane";

type Props = {
  path: string;
  overrideLanguage?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
};

/** 判断必须使用可编辑文本阅览器的结构化数据文件。 */
function isStructuredTextPath(path: string): boolean {
  const extension = path.split(".").pop()?.toLowerCase();
  return extension === "json" || extension === "jsonl";
}

// 根据文件类型分发轻量预览或常规可编辑代码阅览器。
export const FileViewer = memo(
  forwardRef<EditorPaneHandle, Props>(function FileViewer(props, ref) {
    if (isStructuredTextPath(props.path)) {
      return <EditorPane ref={ref} {...props} />;
    }
    if (getPreviewKind(props.path)) {
      return (
        <FilePreviewPane
          ref={ref}
          path={props.path}
          onDirtyChange={props.onDirtyChange}
        />
      );
    }
    return <EditorPane ref={ref} {...props} />;
  }),
);
