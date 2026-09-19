import { useEffect, useRef, useState, type ComponentProps } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { CodexClient } from "./client";
import type { Request, Session } from "./protocol";
type Icon = ComponentProps<typeof HugeiconsIcon>["icon"];
/** 使用现有图标体系提供固定尺寸和可访问名称。 */
export function Tool({
  icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: Icon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      <HugeiconsIcon icon={icon} size={14} />
    </Button>
  );
}

/** 标题编辑采用原生输入框并在失焦或回车后同步右侧列表。 */
export function Title({
  session,
  client,
}: {
  session: Session;
  client: CodexClient;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const committing = useRef(false);
  const editor = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      editor.current?.focus();
      editor.current?.select();
    }
  }, [editing]);
  const title = session.thread.name || session.thread.preview || "新对话";
  const project = session.thread.cwd
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .pop();
  /** 避免回车和失焦重复提交同一次标题修改。 */
  const commit = () => {
    if (committing.current) return;
    committing.current = true;
    setEditing(false);
    void client
      .rename(session.thread.id, value)
      .catch((error) => toast.error(String(error)));
  };
  return editing ? (
    <input
      className="codex-title-input"
      aria-label="会话名称"
      ref={editor}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") {
          committing.current = true;
          setEditing(false);
        }
      }}
    />
  ) : (
    <button
      type="button"
      className="codex-title"
      title={`${title} (${session.thread.cwd})`}
      onDoubleClick={() => {
        committing.current = false;
        setValue(title);
        setEditing(true);
      }}
      onKeyDown={(event) => {
        if (event.key === "F2") {
          committing.current = false;
          setValue(title);
          setEditing(true);
        }
      }}
    >
      {title} <span className="text-muted-foreground">({project})</span>
    </button>
  );
}

/** 按官方审批类型提交明确选择，提问支持选项与自由输入。 */
export function Approval({
  request,
  sessionId,
  client,
}: {
  request: Request;
  sessionId: string;
  client: CodexClient;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const questions = request.params.questions;
  /** 只有成功发出响应后才由客户端移除审批。 */
  const respond = async (result: unknown) => {
    setBusy(true);
    try {
      await client.respond(sessionId, request.id, result);
    } catch (error) {
      toast.error(String(error));
      setBusy(false);
    }
  };
  const permissions = request.method === "item/permissions/requestApproval";
  const decisions = request.params.availableDecisions;
  return (
    <section className="codex-approval" aria-label="待处理请求">
      <strong>{questions ? "需要你的回复" : "等待审批"}</strong>
      {questions ? (
        questions.map((question) => (
          <fieldset key={question.id} className="block my-2">
            <legend>{question.question}</legend>
            {question.options?.map((option) => (
              <label key={option.label} className="flex gap-2 my-1">
                <input
                  type="radio"
                  name={`${request.id}-${question.id}`}
                  checked={answers[question.id] === option.label}
                  onChange={() =>
                    setAnswers({ ...answers, [question.id]: option.label })
                  }
                />
                {option.label}
              </label>
            ))}
            <input
              aria-label={question.question}
              type={question.isSecret ? "password" : "text"}
              value={answers[question.id] ?? ""}
              onChange={(event) =>
                setAnswers({ ...answers, [question.id]: event.target.value })
              }
              className="codex-title-input"
            />
          </fieldset>
        ))
      ) : (
        <div className="my-2 space-y-2">
          {typeof request.params.reason === "string" && (
            <p>{request.params.reason}</p>
          )}
          {typeof request.params.command === "string" && (
            <pre className="rounded-lg bg-background p-2">
              {request.params.command}
            </pre>
          )}
          {typeof request.params.cwd === "string" && (
            <p
              className="truncate text-[11px] text-muted-foreground"
              title={request.params.cwd}
            >
              {request.params.cwd}
            </p>
          )}
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              请求详情
            </summary>
            <pre>{JSON.stringify(request.params, null, 2)}</pre>
          </details>
        </div>
      )}
      <div className="flex gap-2">
        {questions ? (
          <Button
            size="xs"
            disabled={busy || questions.some((q) => !answers[q.id]?.trim())}
            onClick={() =>
              void respond({
                answers: Object.fromEntries(
                  questions.map((q) => [q.id, { answers: [answers[q.id]] }]),
                ),
              })
            }
          >
            提交回复
          </Button>
        ) : (
          <>
            {(!decisions || decisions.includes("accept") || permissions) && (
              <Button
                size="xs"
                disabled={busy}
                onClick={() =>
                  void respond(
                    permissions
                      ? {
                          permissions: Object.fromEntries(
                            Object.entries(
                              request.params.permissions as Record<
                                string,
                                unknown
                              >,
                            ).filter(([, value]) => value != null),
                          ),
                          scope: "turn",
                        }
                      : { decision: "accept" },
                  )
                }
              >
                允许本次
              </Button>
            )}
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void respond(
                  permissions
                    ? { permissions: {}, scope: "turn" }
                    : { decision: "decline" },
                )
              }
            >
              拒绝
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
