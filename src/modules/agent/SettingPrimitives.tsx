import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 统一设置分组卡片（参考 Codeg `SettingCard` / CC-Switch 卡片表面规范）：
 * 相关设置项放进同一圆角容器，组内以细分隔线连接，避免裸线漂浮在弹窗里。
 */
export function SettingCard({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "divide-y divide-border/60 overflow-hidden rounded-xl border border-border/75 bg-muted/25",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * 卡片内单行设置项（参考 Codeg `SettingRow`）：
 * 左侧标题与说明，右侧固定操作控件，下方可选展开全宽表单区域。
 */
export function SettingRow({
  title,
  description,
  htmlFor,
  control,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  control?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const LabelTag = htmlFor ? "label" : "div";
  return (
    <div className={cn("flex flex-col gap-2.5 px-4 py-3", className)}>
      <div
        className={cn(
          "flex justify-between gap-4",
          description ? "items-start" : "items-center",
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <LabelTag
            {...(htmlFor ? { htmlFor } : {})}
            className={cn(
              "text-xs font-medium text-foreground",
              htmlFor && "cursor-pointer",
            )}
          >
            {title}
          </LabelTag>
          {description && (
            <div className="text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
              {description}
            </div>
          )}
        </div>
        {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
      </div>
      {children}
    </div>
  );
}

/**
 * 卡片风格的说明 / 警告提示块，与周围 `SettingCard` 保持同一视觉语言。
 */
export function SettingNote({
  children,
  tone = "default",
  role,
  className,
}: {
  children: ReactNode;
  tone?: "default" | "warning" | "destructive";
  role?: "alert" | "status";
  className?: string;
}) {
  return (
    <div
      role={role}
      className={cn(
        "rounded-xl border px-3.5 py-2.5 text-[11px] leading-relaxed [overflow-wrap:anywhere]",
        tone === "destructive"
          ? "border-destructive/35 bg-destructive/8 text-destructive"
          : tone === "warning"
            ? "border-amber-500/35 bg-amber-500/8 text-amber-700 dark:text-amber-300"
            : "border-border/75 bg-muted/25 text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * 分区页眉：左侧标题 + 数量徽标 + 副标题，右侧操作按钮组。
 */
export function SettingSectionHeader({
  title,
  count,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  count?: number;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-foreground">{title}</h3>
          {count !== undefined && (
            <span className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full border border-border/70 bg-muted/50 px-1.5 text-[10px] font-medium text-muted-foreground">
              {count}
            </span>
          )}
        </div>
        {description && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {actions}
        </div>
      )}
    </div>
  );
}
