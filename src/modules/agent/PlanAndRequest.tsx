import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  FileValidationIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAgentStore } from "./store";
import {
  formatCompactPathParts,
  type DiffSummary,
  type TurnFileChange,
} from "./toolFormat";
import type { PendingRequest, SessionView } from "./types";

type PlanEntry = {
  content: string;
  status?: string;
  priority?: string;
};

export function parsePlanEntries(raw: string): PlanEntry[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const entries = parsed.filter(
      (item): item is PlanEntry =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as PlanEntry).content === "string",
    );
    return entries.length ? entries : null;
  } catch {
    return null;
  }
}

export function PlanCard({ raw }: { raw: string }) {
  const entries = parsePlanEntries(raw);
  if (!entries) {
    return (
      <details className="agent-notice" open>
        <summary>计划</summary>
        <pre>{raw}</pre>
      </details>
    );
  }
  const doneCount = entries.filter((e) => e.status === "completed").length;
  return (
    <details className="agent-plan-card" open>
      <summary>
        <span className="agent-plan-title">执行计划</span>
        <span className="agent-plan-progress">
          {doneCount}/{entries.length} 已完成
        </span>
      </summary>
      <ul className="agent-plan-list">
        {entries.map((entry, idx) => {
          const status = entry.status ?? "pending";
          const icon =
            status === "completed"
              ? "✓"
              : status === "in_progress"
                ? "●"
                : "○";
          return (
            <li key={`${idx}:${entry.content.slice(0, 40)}`} className={`is-${status}`}>
              <span className="agent-plan-icon" aria-hidden="true">
                {icon}
              </span>
              <span className="agent-plan-text">{entry.content}</span>
              {entry.priority && (
                <span className="agent-plan-prio">{entry.priority}</span>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

export function PlanProgressStrip({
  messages,
}: {
  messages: SessionView["messages"];
}) {
  const latestPlan = [...messages].reverse().find((m) => m.kind === "plan");
  if (!latestPlan) return null;
  const entries = parsePlanEntries(latestPlan.text);
  if (!entries) return null;
  const done = entries.filter((e) => e.status === "completed").length;
  if (done >= entries.length) return null;
  const active =
    entries.find((e) => e.status === "in_progress") ??
    entries.find((e) => e.status !== "completed");
  return (
    <div className="agent-plan-strip" role="status">
      <span className="agent-plan-strip-badge">
        计划 {done}/{entries.length}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {active?.content ?? "进行中"}
      </span>
    </div>
  );
}

export function EditDiffView({
  diff,
  path,
  onOpenDiff,
}: {
  diff: DiffSummary;
  path?: string;
  onOpenDiff?: (path: string, diff: string) => void;
}) {
  const targetPath = path || diff.path || "变更差异";
  return (
    <div className="agent-diff-box">
      <div className="agent-diff-head">
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {targetPath}
        </span>
        <span className="flex items-center gap-2 font-mono text-[10px]">
          {diff.adds > 0 && <span className="text-green-500">+{diff.adds}</span>}
          {diff.dels > 0 && <span className="text-red-500">-{diff.dels}</span>}
          {onOpenDiff && (
            <button
              type="button"
              className="font-sans text-primary hover:underline"
              onClick={() => onOpenDiff(targetPath, diff.rawPatch)}
            >
              在编辑器对比
            </button>
          )}
        </span>
      </div>
      <div className="agent-diff-lines">
        {diff.lines.slice(0, 120).map((line, i) => (
          <div key={i} className={`agent-diff-line is-${line.kind}`}>
            {line.text || " "}
          </div>
        ))}
        {diff.lines.length > 120 && (
          <div className="agent-diff-line is-meta">
            … 仅预览前 120 行（共 {diff.lines.length} 行）
          </div>
        )}
      </div>
    </div>
  );
}

function fileTypeBadge(ext: string): { label: string; toneClass: string } {
  switch (ext) {
    case "ts":
    case "tsx":
      return { label: "TS", toneClass: "is-ts" };
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return { label: "JS", toneClass: "is-js" };
    case "rs":
      return { label: "RS", toneClass: "is-rs" };
    case "py":
      return { label: "PY", toneClass: "is-py" };
    case "yaml":
    case "yml":
      return { label: "Y", toneClass: "is-yaml" };
    case "md":
    case "mdx":
      return { label: "M↓", toneClass: "is-md" };
    case "json":
      return { label: "{}", toneClass: "is-json" };
    case "css":
    case "scss":
      return { label: "#", toneClass: "is-css" };
    case "toml":
      return { label: "T", toneClass: "is-toml" };
    default:
      return { label: (ext.slice(0, 2) || "·").toUpperCase(), toneClass: "" };
  }
}

export function TurnFileChangesBar({
  changes,
  cwd = "",
  mobile,
  onOpenFile,
  onOpenDiff,
}: {
  changes: TurnFileChange[];
  cwd?: string;
  mobile?: boolean;
  onOpenFile: (path: string) => void;
  onOpenDiff?: (path: string, diff: string, options?: { activate?: boolean }) => void;
}) {
  const [open, setOpen] = useState(true);
  if (!changes.length) return null;
  const totalAdds = changes.reduce((sum, c) => sum + c.adds, 0);
  const totalDels = changes.reduce((sum, c) => sum + c.dels, 0);
  const hasStats = totalAdds > 0 || totalDels > 0;

  const reveal = async (item: TurnFileChange) => {
    try {
      await revealItemInDir(
        item.operation === "删除"
          ? `${item.path.slice(0, item.path.lastIndexOf("/"))}/`
          : item.path,
      );
    } catch (error) {
      toast.error("无法在资源管理器中定位", { description: String(error) });
    }
  };

  const openItemDiffOrFile = (
    item: TurnFileChange,
    options?: { activate?: boolean },
  ) => {
    if (onOpenDiff) {
      onOpenDiff(item.path, item.diffText ?? "", options);
    } else if (item.operation === "删除") {
      void reveal(item);
    } else {
      onOpenFile(item.path);
    }
  };

  const handleReviewAll = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!onOpenDiff) {
      const first = changes[0];
      if (first) openItemDiffOrFile(first);
      return;
    }
    changes.forEach((item, index) => {
      onOpenDiff(item.path, item.diffText ?? "", { activate: index === 0 });
    });
  };

  return (
    <details
      className="agent-turn-files"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="agent-turn-files-summary">
        <div className="agent-turn-files-head-left">
          <span className="agent-turn-files-count">
            {changes.length} 个文件变更
          </span>
          {hasStats && (
            <span className="agent-turn-files-stats">
              <span className="is-add">+{totalAdds}</span>
              <span className="is-del">-{totalDels}</span>
            </span>
          )}
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={13}
            className={`agent-turn-files-chevron ${open ? "is-open" : ""}`}
          />
        </div>
        {(onOpenDiff || changes.length > 0) && (
          <button
            type="button"
            className="agent-turn-review-btn"
            title="在主编辑器打开全部变更文件进行对比审查"
            onClick={handleReviewAll}
          >
            <HugeiconsIcon icon={FileValidationIcon} size={13} />
            <span>代码审查</span>
          </button>
        )}
      </summary>
      <div className="agent-turn-files-list">
        {changes.map((item) => {
          const { fileName, dirDisplay, ext } = formatCompactPathParts(
            item.path,
            cwd,
          );
          const badge = fileTypeBadge(ext);
          const itemHasStats = item.adds > 0 || item.dels > 0;
          return (
            <div key={item.path} className="agent-turn-file-row">
              <button
                type="button"
                className="agent-turn-file-main"
                title={
                  onOpenDiff
                    ? `点击对比差异: ${item.path}`
                    : `点击打开文件: ${item.path}`
                }
                onClick={() => openItemDiffOrFile(item, { activate: true })}
              >
                <span className={`agent-file-badge ${badge.toneClass}`}>
                  {badge.label}
                </span>
                <span className="agent-turn-file-name">{fileName}</span>
                {dirDisplay && (
                  <span className="agent-turn-file-dir">{dirDisplay}</span>
                )}
              </button>
              <div className="agent-turn-file-right">
                {itemHasStats ? (
                  <span className="agent-turn-files-stats">
                    <span className="is-add">+{item.adds}</span>
                    <span className="is-del">-{item.dels}</span>
                  </span>
                ) : (
                  <span className="agent-file-op-tag">{item.operation}</span>
                )}
                {!mobile && (
                  <button
                    type="button"
                    className="agent-turn-file-reveal"
                    title="在系统目录中显示"
                    onClick={() => void reveal(item)}
                  >
                    ↗
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function summarizeRequestBody(message: string): {
  command?: string;
  path?: string;
  body: string;
  isJson: boolean;
} {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{")) {
    return { body: message, isJson: false };
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const command =
      typeof parsed.command === "string"
        ? parsed.command
        : typeof parsed.cmd === "string"
          ? parsed.cmd
          : undefined;
    const path =
      typeof parsed.path === "string"
        ? parsed.path
        : typeof parsed.file_path === "string"
          ? parsed.file_path
          : typeof parsed.filePath === "string"
            ? parsed.filePath
            : undefined;
    const detail =
      typeof parsed.description === "string"
        ? parsed.description
        : typeof parsed.reason === "string"
          ? parsed.reason
          : message;
    return { command, path, body: detail, isJson: true };
  } catch {
    return { body: message, isJson: false };
  }
}

export function StructuredRequestCard({
  request,
  session,
}: {
  request: PendingRequest;
  session: SessionView;
}) {
  const [value, setValue] = useState(request.defaultValue);
  const [busy, setBusy] = useState(false);
  const reply = (payload: unknown) => {
    setBusy(true);
    void useAgentStore
      .getState()
      .command(
        request.kind === "permission" ? "permission.respond" : "extension.respond",
        { id: request.id, ...(payload as object) },
        session.id,
      )
      .catch((error) => {
        setBusy(false);
        useAgentStore.getState().report(error);
      });
  };
  const isFsWrite = request.id.startsWith("fs-write:");
  const isPermission = request.kind === "permission";
  const scopeLabel = isFsWrite
    ? "工作区内文件写入"
    : isPermission
      ? "代理工具权限"
      : "扩展交互请求";
  const parsed = summarizeRequestBody(request.message);
  const isSecret = /password|secret|token|key|口令|密码/iu.test(
    `${request.title} ${request.message}`,
  );
  const isDestructiveGit =
    /\bgit\s+(push\s+.*(-f|--force|--force-with-lease)|reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|checkout\s+--\s+\.)/iu.test(
      `${parsed.command ?? ""} ${request.message}`,
    );

  return (
    <fieldset className="agent-request" disabled={busy}>
      <legend className="flex items-center gap-2">
        <span className="agent-request-scope">{scopeLabel}</span>
        <span>{request.title || "代理需要你的确认"}</span>
      </legend>
      {isDestructiveGit && (
        <div className="mb-2 rounded border border-destructive/50 bg-destructive/15 px-2.5 py-1.5 text-[11px] font-medium text-destructive">
          高危 Git 操作预警：该命令可能覆盖远端提交历史或不可逆清除工作区未保存更改，请仔细核对！
        </div>
      )}
      {(parsed.path || parsed.command) && (
        <div className="agent-request-meta">
          {parsed.path && (
            <div>
              <strong>目标路径：</strong>
              <code>{parsed.path}</code>
            </div>
          )}
          {parsed.command && (
            <div>
              <strong>执行命令：</strong>
              <code>{parsed.command}</code>
            </div>
          )}
        </div>
      )}
      {request.message &&
        (parsed.isJson ? (
          <details className="mb-2 text-[11px] text-muted-foreground">
            <summary className="cursor-pointer select-none">
              查看请求完整细节
            </summary>
            <pre className="mt-1">{request.message}</pre>
          </details>
        ) : (
          <pre>{request.message}</pre>
        ))}
      {isPermission ? (
        <div className="flex flex-wrap gap-2">
          {request.options.map((option, idx) => {
            const item =
              typeof option === "string"
                ? { optionId: option, name: option, kind: "" }
                : option;
            const isReject =
              item.optionId === "reject" ||
              item.kind?.startsWith("reject") ||
              /拒绝|取消|否/u.test(item.name);
            return (
              <Button
                key={`${idx}:${item.optionId}`}
                size="sm"
                variant={isReject ? "outline" : "default"}
                autoFocus={isReject}
                onClick={() => reply({ optionId: item.optionId })}
              >
                {item.name}
              </Button>
            );
          })}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => reply({ optionId: "" })}
          >
            忽略 / 取消
          </Button>
        </div>
      ) : request.kind === "confirm" ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            autoFocus
            onClick={() => reply({ confirmed: false })}
          >
            否（安全默认）
          </Button>
          <Button size="sm" onClick={() => reply({ confirmed: true })}>
            是，确认继续
          </Button>
        </div>
      ) : request.kind === "select" ? (
        <div className="flex flex-wrap gap-2">
          {request.options.map((option) => {
            const label = typeof option === "string" ? option : option.name;
            return (
              <Button
                key={label}
                size="sm"
                variant="outline"
                onClick={() => reply({ value: label })}
              >
                {label}
              </Button>
            );
          })}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => reply({ cancelled: true })}
          >
            取消
          </Button>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            reply({ value });
          }}
        >
          {request.kind === "editor" ? (
            <textarea
              rows={4}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          ) : (
            <Input
              type={isSecret ? "password" : "text"}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
          <Button size="sm" type="submit">
            提交
          </Button>
          <Button
            size="sm"
            variant="ghost"
            type="button"
            onClick={() => reply({ cancelled: true })}
          >
            取消
          </Button>
        </form>
      )}
    </fieldset>
  );
}
