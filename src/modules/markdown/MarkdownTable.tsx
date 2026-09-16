import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { useRef, useState, type ComponentProps, type MouseEvent } from "react";
import { cn } from "@/lib/utils";
import { htmlTableToMarkdown } from "./tableMarkdown";

type TableProps = ComponentProps<"table"> & { node?: unknown };

/** Streamdown 表格：只提供一键复制 Markdown，不再弹出 CSV/TSV。 */
export function MarkdownTable({
  className,
  children,
  node: _node,
  ...props
}: TableProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);

  const copyMarkdown = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const table = wrapRef.current?.querySelector("table");
    if (!table || typeof navigator === "undefined") return;
    const markdown = htmlTableToMarkdown(table);
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      ref={wrapRef}
      className="my-4 flex flex-col gap-2 rounded-lg border border-border bg-sidebar p-2"
      data-streamdown="table-wrapper"
    >
      <div className="flex items-center justify-end">
        <button
          type="button"
          className="cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground"
          title="复制为 Markdown"
          aria-label="复制为 Markdown"
          onClick={(event) => void copyMarkdown(event)}
        >
          <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={14} />
        </button>
      </div>
      <div className="overflow-x-auto overflow-y-auto rounded-md border border-border bg-background">
        <table
          {...props}
          className={cn("w-full divide-y divide-border", className)}
          data-streamdown="table"
        >
          {children}
        </table>
      </div>
    </div>
  );
}
