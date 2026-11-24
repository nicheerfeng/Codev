import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useVcsStore } from "@/modules/vcs/store";
import { Cancel01Icon, CheckmarkCircle02Icon, Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/** Git 环境体检与一键配置向导，包含推荐默认设置及分支图速览指南。 */
export function VcsDoctorModal({
  root,
  open,
  onClose,
}: {
  root: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const doctor = useVcsStore((s) => s.doctor);
  const checkDoctor = useVcsStore((s) => s.checkDoctor);
  const fixDoctor = useVcsStore((s) => s.fixDoctor);
  const refreshSnapshot = useVcsStore((s) => s.refreshSnapshot);

  const [userName, setUserName] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    void checkDoctor(root ?? undefined)
      .then((rep) => {
        setUserName(rep.userName ?? "");
        setUserEmail(rep.userEmail ?? "");
      })
      .catch((e) => toast.error(String(e)));
  }, [open, root, checkDoctor]);

  if (!open) return null;

  const applyFixes = async () => {
    setSaving(true);
    try {
      await fixDoctor({
        userName: userName.trim() || undefined,
        userEmail: userEmail.trim() || undefined,
        applyRecommended: true,
      });
      await checkDoctor(root ?? undefined);
      if (root) await refreshSnapshot(root);
      toast.success("已应用 Git 推荐配置");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]">
      <div className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-border/70 px-4">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold">Git 环境体检与配置向导</span>
            {doctor?.gitVersion && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {doctor.gitVersion}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="关闭"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={14} />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto p-4 text-[12px]">
          <section className="space-y-2 rounded-md border border-border/60 bg-background/40 p-3">
            <div className="font-medium text-foreground">提交身份与基础参数</div>
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="text-[11px] text-muted-foreground">作者姓名 (user.name)</span>
                <Input
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  placeholder="例如：你的名字"
                  className="h-7 text-[11px]"
                />
              </label>
              <label className="space-y-1">
                <span className="text-[11px] text-muted-foreground">作者邮箱 (user.email)</span>
                <Input
                  value={userEmail}
                  onChange={(e) => setUserEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="h-7 text-[11px]"
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-1.5 pt-1 text-[11px] text-muted-foreground">
              <div>默认主分支：<code className="text-foreground">{doctor?.defaultBranch ?? "未设（推荐 main）"}</code></div>
              <div>换行处理：<code className="text-foreground">{doctor?.autocrlf ?? "未设（Win推荐 input）"}</code></div>
              <div>拉取策略：<code className="text-foreground">{doctor?.pullRebase ?? "未设（推荐 true）"}</code></div>
              <div>gh CLI：<code className="text-foreground">{doctor?.ghAuthenticated ? "已登录" : doctor?.ghInstalled ? "已安装未登录" : "未安装"}</code></div>
            </div>
          </section>

          {doctor && (
            <section className="space-y-1.5">
              <div className="font-medium text-foreground">检测项（{doctor.issues.length} 项建议）</div>
              {doctor.issues.length === 0 ? (
                <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-300">
                  <HugeiconsIcon icon={CheckmarkCircle02Icon} size={14} />
                  当前 Git 与身份环境健康，可放心使用全功能！
                </div>
              ) : (
                <div className="space-y-1.5">
                  {doctor.issues.map((issue) => (
                    <div
                      key={issue.id}
                      className={cn(
                        "flex items-start gap-2 rounded-md border px-2.5 py-2 text-[11px]",
                        issue.severity === "error"
                          ? "border-destructive/40 bg-destructive/10 text-destructive"
                          : "border-border/60 bg-muted/40 text-foreground",
                      )}
                    >
                      <HugeiconsIcon icon={Alert02Icon} size={13} className="mt-0.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{issue.title}</div>
                        <div className="text-[10px] opacity-80">{issue.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          <section className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-3 text-[11px]">
            <div className="font-medium text-foreground">30 秒看懂 Codev 分支与日常协同</div>
            <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
              <li><strong className="text-foreground">HEAD → 分支名</strong>：你当前所在的真实工作分支；若处于游离指针可一键转为新分支。</li>
              <li><strong className="text-foreground">↑2 ↓1 同步徽标</strong>：<code className="text-foreground">↑2</code> 表示本地超前 2 次待推送；<code className="text-foreground">↓1</code> 表示远端有新提交需拉取。</li>
              <li><strong className="text-foreground">主干干净 + Worktree 隔离</strong>：让 Agent 修 Bug 或同时开多个需求时，在 <code className="text-foreground">分支与工作区</code> 新建 Worktree，互不踩踏现场。</li>
            </ul>
          </section>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border/70 px-4 py-2.5">
          <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={onClose}>
            关闭
          </Button>
          <Button size="sm" className="h-7 text-[11px]" disabled={saving} onClick={() => void applyFixes()}>
            {saving ? "正在写入…" : "应用身份与推荐规范"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
