import { useCallback, useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import {
  RECOMMENDED_PI_PLUGINS,
  isRecommendedPluginInstalled,
} from "@/modules/plugins/pi-agent/recommendedPlugins";
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

  return (
    <section>
      <div className="flex items-center gap-2 pb-3">
        <strong className="flex-1">
          {kind === "skills" ? "技能" : "插件"} · {items.length}
        </strong>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void refresh()}
        >
          刷新
        </Button>
      </div>
      {kind === "plugins" && (
        <div className="agent-provider-tabs">
          <Button
            size="sm"
            variant={tab === "installed" ? "secondary" : "ghost"}
            onClick={() => setTab("installed")}
          >
            已安装
          </Button>
          <Button
            size="sm"
            variant={tab === "recommended" ? "secondary" : "ghost"}
            onClick={() => setTab("recommended")}
          >
            推荐安装
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="agent-settings-note text-destructive">
          {error}
        </p>
      )}
      {kind === "plugins" && tab === "recommended" ? (
        RECOMMENDED_PI_PLUGINS.map((plugin) => {
          const installed = isRecommendedPluginInstalled(
            plugin.package,
            items.map((item) => ({ name: item.name, spec: item.name })),
          );
          return (
            <div className="agent-setting-row" key={plugin.package}>
              <div>
                <strong>{plugin.name}</strong>
                <p>{plugin.summary}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || installed}
                onClick={() => void install(plugin.package)}
              >
                {installed ? "已安装" : "安装"}
              </Button>
            </div>
          );
        })
      ) : (
        <>
          {!items.length && !busy && (
            <p className="agent-settings-note">
              暂无{kind === "skills" ? "技能" : "插件"}
            </p>
          )}
          {items.map((item) => (
            <div
              className="agent-setting-row"
              key={`${item.source}:${item.path}:${item.name}`}
            >
              <div className="min-w-0">
                <strong>{item.name}</strong>
                <p>
                  {item.source}
                  {item.path ? ` · ${item.path}` : ""}
                </p>
              </div>
              {item.path && (
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
              )}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
