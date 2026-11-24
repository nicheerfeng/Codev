import { useCallback, useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { SettingCard, SettingNote, SettingRow, SettingSectionHeader } from "./SettingPrimitives";
import { useAgentStore } from "./store";

type Asset = { name: string; path: string; source: string; status?: string | null };

export function HarnessAssetsPanel({ harnessId, kind }: { harnessId: string; kind: "skills" | "plugins" }) {
  const workspaceId = useAgentStore((state) => state.workspaceId);
  const [items, setItems] = useState<Asset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++requestId.current;
    setBusy(true);
    setError("");
    try {
      const result = await useAgentStore.getState().command<{ items: Asset[] }>(
        "harness.assets.list", { harnessId, kind, workspaceId },
      );
      if (requestId.current === current) setItems(result.items);
    } catch (failure) {
      if (requestId.current === current) {
        setItems([]);
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      if (requestId.current === current) setBusy(false);
    }
  }, [harnessId, kind, workspaceId]);
  useEffect(() => { void refresh(); return () => { requestId.current += 1; }; }, [refresh]);

  const title = kind === "skills" ? "技能" : "插件";
  return (
    <section className="space-y-4">
      <SettingSectionHeader
        title={title}
        count={items.length}
        description={
          kind === "skills"
            ? "当前工作区与全局环境中扫描到的可用技能。"
            : "当前代理配置中的扩展与插件状态。"
        }
        actions={
          <Button size="icon-sm" variant="ghost" disabled={busy} title="刷新" aria-label="刷新" onClick={() => void refresh()}>
            <HugeiconsIcon icon={Refresh01Icon} size={15} />
          </Button>
        }
      />
      {error && (
        <SettingNote tone="destructive" role="alert">
          {error}
        </SettingNote>
      )}
      {!error && !items.length && (
        <SettingNote>{busy ? "正在读取…" : `暂无${title}`}</SettingNote>
      )}
      {items.length > 0 && (
        <SettingCard>
          {items.map((item) => (
            <SettingRow
              key={`${item.source}:${item.path}:${item.name}`}
              title={
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <span>{item.name}</span>
                  <span className="rounded-md border border-border/70 bg-muted/60 px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                    {item.source}
                  </span>
                </span>
              }
              description={item.path ? <span className="font-mono text-[10px]">{item.path}</span> : undefined}
              control={
                <>
                  {item.status && (
                    <span className="rounded-full border border-border/70 bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
                      {item.status}
                    </span>
                  )}
                  {item.path && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void revealItemInDir(item.path).catch(useAgentStore.getState().report)}
                    >
                      打开位置
                    </Button>
                  )}
                </>
              }
            />
          ))}
        </SettingCard>
      )}
    </section>
  );
}
