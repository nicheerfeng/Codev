import { useEffect, useRef, useState, type ReactNode } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { EditorView } from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Copy01Icon,
  Delete02Icon,
  FloppyDiskIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { useEditorThemeExt } from "@/modules/editor/lib/useEditorThemeExt";

/** 按钮二次点击确认删除，移开焦点即取消确认。 */
export function ModelRemoveButton({
  label,
  disabled,
  onRemove,
}: {
  label: string;
  disabled: boolean;
  onRemove: () => void;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <Button
      variant="ghost"
      size={armed ? "xs" : "icon-xs"}
      disabled={disabled}
      aria-label={armed ? `确认${label}` : label}
      title={armed ? `再次点击${label}` : label}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onRemove();
        } else setArmed(true);
      }}
    >
      {armed ? "确认删除" : <HugeiconsIcon icon={Delete02Icon} size={13} />}
    </Button>
  );
}

/** 使用 Codev JSON 编辑器显示一张独立配置卡，保留搜索、选区和主题。 */
export function PiModelCard({
  title,
  label,
  text,
  error,
  dirty,
  busy,
  onChange,
  onSave,
  onRemove,
  onDuplicate,
  onTest,
  testStatus,
}: {
  title: ReactNode;
  label: string;
  text: string;
  error?: string;
  dirty: boolean;
  busy: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onRemove: () => void;
  onDuplicate?: () => void;
  onTest?: () => void;
  testStatus?: string;
}) {
  const editor = useRef<ReactCodeMirrorRef>(null);
  const theme = useEditorThemeExt();
  useEffect(() => {
    const view = editor.current?.view;
    if (view && view.state.doc.toString() !== text)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
  }, [text]);
  /** 打开当前卡片内部搜索，避免触发线程搜索。 */
  const search = () => {
    if (editor.current?.view) openSearchPanel(editor.current.view);
  };
  return (
    <section
      aria-label={label}
      className="flex h-[440px] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card"
      onKeyDownCapture={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (!busy && dirty) onSave();
        }
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault();
          event.stopPropagation();
          search();
        }
      }}
    >
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-border/70 px-2 py-2">
        <div className="min-w-0 flex-1 text-xs font-medium">{title}</div>
        {dirty && (
          <span
            role="img"
            className="size-1.5 shrink-0 rounded-full bg-[#8eacc9]"
            title="未保存"
            aria-label="未保存"
          />
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`搜索${label}`}
          title="搜索此卡片"
          onClick={search}
        >
          <HugeiconsIcon icon={Search01Icon} size={13} />
        </Button>
        {onDuplicate && (
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={busy}
            aria-label={`复制${label}`}
            title="复制为新模型"
            onClick={onDuplicate}
          >
            <HugeiconsIcon icon={Copy01Icon} size={13} />
          </Button>
        )}
        {onTest && (
          <Button
            variant="ghost"
            size="xs"
            disabled={busy}
            aria-label={`测试${label}`}
            title="对已保存配置发送一次短请求"
            onClick={onTest}
          >
            测试
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={busy || !dirty}
          aria-label={`保存${label}`}
          title="保存此卡片"
          onClick={onSave}
        >
          <HugeiconsIcon icon={FloppyDiskIcon} size={13} />
        </Button>
        <ModelRemoveButton
          label={`删除${label}`}
          disabled={busy}
          onRemove={onRemove}
        />
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <CodeMirror
          ref={editor}
          value={text}
          onChange={onChange}
          height="100%"
          className="h-full"
          theme={theme}
          extensions={[json(), EditorView.lineWrapping]}
          editable={!busy}
          basicSetup={{
            highlightActiveLine: false,
            highlightSelectionMatches: false,
            foldGutter: true,
          }}
        />
      </div>
      {error && (
        <p
          role="status"
          className="reader-scrollbar max-h-16 shrink-0 overflow-auto border-t border-border px-3 py-2 text-xs text-amber-600 dark:text-amber-300"
        >
          {error}
        </p>
      )}
      {testStatus && (
        <p
          role="status"
          className="reader-scrollbar max-h-16 shrink-0 overflow-auto border-t border-border px-3 py-2 text-xs text-muted-foreground"
        >
          {testStatus}
        </p>
      )}
    </section>
  );
}
