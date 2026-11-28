import { useCallback, useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import {
  RECOMMENDED_PI_PLUGINS,
  isRecommendedPluginInstalled,
} from "./recommendedPlugins";
import {
  SettingCard,
  SettingNote,
  SettingRow,
  SettingSectionHeader,
} from "./SettingPrimitives";
import { useAgentStore } from "./store";

type Asset = { name: string; path: string; source: string };

export function PiAssetsPanel({ kind }: { kind: "skills" | "plugins" }) {
  const workspaceId = useAgentStore((state) => state.workspaceId);
  const [items, setItems] = useState<Asset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"installed" | "recommended">("installed");
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const result = await useAgentStore
        .getState()
        .command<{ items: Asset[] }>("pi.assets.list", { kind, workspaceId });
      setItems(result.items);
      setError("");
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  }, [kind, workspaceId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install = async (name: string) => {
    if (!window.confirm(`安装插件 ${name}？`)) return;
    setBusy(true);
    try {
      await useAgentStore
        .getState()
        .command("pi.plugins.install", { package: name });
      await refresh();
    } catch (value) {
      setError(String(value));
      setBusy(false);
    }
  };

  const title = kind === "skills" ? "技能" : "插件";
  return (
    <section className="space-y-4">
      <SettingSectionHeader
        title={title}
        count={items.length}
        description={
          kind === "skills"
            ? "Pi 工作区与全局技能目录清单。"
            : "管理已安装的 Pi 扩展包，或一键安装常用推荐插件。"
        }
        actions={
          <>
            {kind === "plugins" && (
              <div className="inline-flex items-center rounded-lg border border-border/75 bg-muted/40 p-0.5">
                <Button
                  size="xs"
                  variant={tab === "installed" ? "secondary" : "ghost"}
                  onClick={() => setTab("installed")}
                >
                  已安装
                </Button>
                <Button
                  size="xs"
                  variant={tab === "recommended" ? "secondary" : "ghost"}
                  onClick={() => setTab("recommended")}
                >
                  推荐安装
                </Button>
              </div>
            )}
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={busy}
              title="刷新"
              aria-label="刷新"
              onClick={() => void refresh()}
            >
              <HugeiconsIcon icon={Refresh01Icon} size={15} />
            </Button>
          </>
        }
      />

      {error && (
        <SettingNote tone="destructive" role="alert">
          {error}
        </SettingNote>
      )}

      {kind === "plugins" && tab === "recommended" ? (
        <SettingCard>
          {RECOMMENDED_PI_PLUGINS.map((plugin) => {
            const installed = isRecommendedPluginInstalled(
              plugin.package,
              items.map((item) => ({ name: item.name, spec: item.name })),
            );
            return (
              <SettingRow
                key={plugin.package}
                title={plugin.name}
                description={plugin.summary}
                control={
                  <Button
                    size="sm"
                    variant={installed ? "ghost" : "outline"}
                    disabled={busy || installed}
                    onClick={() => void install(plugin.package)}
                  >
                    {installed ? "已安装" : "安装"}
                  </Button>
                }
              />
            );
          })}
        </SettingCard>
      ) : (
        <>
          {!items.length && !busy && <SettingNote>暂无{title}</SettingNote>}
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
                  description={
                    item.path ? (
                      <span className="font-mono text-[10px]">{item.path}</span>
                    ) : undefined
                  }
                  control={
                    item.path && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void revealItemInDir(item.path).catch(
                            useAgentStore.getState().report,
                          )
                        }
                      >
                        打开位置
                      </Button>
                    )
                  }
                />
              ))}
            </SettingCard>
          )}
        </>
      )}
    </section>
  );
}
