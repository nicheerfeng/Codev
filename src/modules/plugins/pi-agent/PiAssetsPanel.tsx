import { useCallback, useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { listPiAssets, type PiAsset } from "./native";

/** 展示技能或插件清单，仅提供刷新和内容阅读。 */
export function PiAssetsPanel({ kind }: { kind: "skills" | "plugins" }) {
  const [items, setItems] = useState<PiAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    try { setItems(await listPiAssets(kind)); }
    catch (value) { setError(String(value)); }
    finally { setBusy(false); }
  }, [kind]);
  useEffect(() => { void refresh(); }, [refresh]);
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={kind === "skills" ? "技能展示" : "插件展示"}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-3 sm:px-4">
        <h2 className="flex-1 text-sm font-medium">{kind === "skills" ? "技能" : "插件"}</h2>
        <span className="text-xs text-muted-foreground">{items.length} 项</span>
        <Button variant="ghost" size="icon-sm" title="刷新" aria-label="刷新" disabled={busy} onClick={() => void refresh()}>
          <HugeiconsIcon icon={Refresh01Icon} className={busy ? "animate-spin" : ""} size={14} />
        </Button>
      </div>
      <div className="reader-scrollbar min-h-0 flex-1 overflow-auto p-3 sm:p-4">
        {error && <p role="alert" className="text-xs text-amber-600">{error}</p>}
        {!busy && !error && !items.length && <p className="py-12 text-center text-xs text-muted-foreground">暂无可展示内容</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <article key={`${item.source}:${item.path}`} className="min-h-32 rounded-lg border border-border bg-card p-3 shadow-sm">
              <h3 className="truncate text-sm font-medium" title={item.name}>{item.name}</h3>
              <p className="mt-1 text-[10px] text-muted-foreground">{item.source}</p>
              <p className="mt-2 line-clamp-3 break-words text-xs text-muted-foreground">{item.summary || "暂无简介"}</p>
              <p className="mt-2 break-all text-[10px] text-muted-foreground/80" title={item.path}>{item.path}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
