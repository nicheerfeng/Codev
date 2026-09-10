import { useEffect, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { EditorView } from "@codemirror/view";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useEditorThemeExt } from "@/modules/editor/lib/useEditorThemeExt";
import { readPiModels, writePiModels } from "./native";

/** 直接编辑 Pi 原生 models.json；保存前验证，沿用 Codev 编辑器主题。 */
export function PiSettings({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [path, setPath] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const theme = useEditorThemeExt();
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoaded(false);
    setMessage("");
    void readPiModels()
      .then((file) => {
        if (!cancelled) {
          setPath(file.path);
          setText(file.content);
          setLoaded(true);
        }
      })
      .catch((error) => {
        if (!cancelled) setMessage(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);
  /** 保留用户 JSON 字段，直接校验保存，不生成备份或第二份模型配置。 */
  const save = async () => {
    setBusy(true);
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("根节点必须是 JSON 对象");
      if (
        parsed.providers !== undefined &&
        (!parsed.providers ||
          typeof parsed.providers !== "object" ||
          Array.isArray(parsed.providers))
      )
        throw new Error("providers 必须是对象");
      await writePiModels(text);
      setMessage(
        "已保存。新启动的会话读取最新配置；运行中的任务继续使用当前配置。",
      );
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] flex-col gap-3 rounded-2xl sm:max-w-2xl"
        showCloseButton={false}
      >
        <div className="flex items-center">
          <DialogTitle className="flex-1">Pi 模型设置</DialogTitle>
          <Button size="sm" variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </div>
        <DialogDescription className="break-all">
          {path || "正在读取 models.json…"}
        </DialogDescription>
        <div
          className="min-h-0 overflow-hidden rounded-lg border border-border"
          onKeyDown={(event) => {
            if (
              (event.ctrlKey || event.metaKey) &&
              event.key.toLowerCase() === "s"
            ) {
              event.preventDefault();
              event.stopPropagation();
              if (loaded && !busy) void save();
            }
          }}
        >
          <CodeMirror
            value={text}
            onChange={setText}
            height="min(45vh, 420px)"
            theme={theme}
            extensions={[json(), EditorView.lineWrapping]}
            editable={loaded}
            basicSetup={{
              highlightActiveLine: false,
              highlightSelectionMatches: false,
            }}
          />
        </div>
        <div role="status" className="text-xs text-muted-foreground">
          {message}
        </div>
        <Button
          className="self-end"
          disabled={!loaded || busy}
          onClick={() => void save()}
        >
          {busy ? "保存中…" : "保存 models.json"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
