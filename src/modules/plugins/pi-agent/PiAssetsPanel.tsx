import { useCallback, useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Refresh01Icon, Copy01Icon } from "@hugeicons/core-free-icons";
import { invoke } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
} from "@/components/ui/hover-card";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { openExternalUrl } from "@/lib/external-link";
import {
  installPiPackage,
  listPiAssets,
  listPiPackageSpecs,
  type PiAsset,
} from "./native";
import {
  isRecommendedPluginInstalled,
  RECOMMENDED_PI_PLUGINS,
  recommendedInstallSpec,
  type RecommendedPiPlugin,
} from "./recommendedPlugins";

/** 在窗口边界内展示可选择、换行和滚动的完整简介。 */
function AssetSummary({ summary }: { summary?: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={250}>
      <HoverCardTrigger asChild>
        <p
          tabIndex={0}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
          className="mt-2 line-clamp-2 break-words text-xs leading-5 text-muted-foreground"
        >
          {summary || "暂无简介"}
        </p>
      </HoverCardTrigger>
      <HoverCardContent
        collisionPadding={12}
        className="reader-scrollbar select-text w-[min(24rem,calc(100vw-2rem))] max-h-[min(45vh,var(--radix-hover-card-content-available-height))] overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-lg border border-border p-3 text-xs leading-5"
      >
        {summary || "暂无简介"}
      </HoverCardContent>
    </HoverCard>
  );
}

/** 展示可复制的资源信息，目录直接打开，文件则定位到所在目录。 */
function AssetCard({ item }: { item: PiAsset }) {
  /** 复制原始标题并反馈结果。 */
  const copyName = async () => {
    try {
      await writeText(item.name);
      toast.success("已复制标题");
    } catch (error) {
      toast.error("复制失败", { description: String(error) });
    }
  };
  /** 查询本机资源类型，打开目录或在目录中定位文件。 */
  const openFolder = async () => {
    try {
      const stat = await invoke<{ kind: string }>("fs_stat", {
        path: item.path,
      });
      if (stat.kind === "dir") await openPath(item.path);
      else await revealItemInDir(item.path);
    } catch (error) {
      toast.error("无法打开资源目录", { description: String(error) });
    }
  };
  return (
    <article className="select-text min-w-0 min-h-32 rounded-lg border border-border bg-card p-3 shadow-sm">
      <div className="flex items-start gap-1">
        <h3 className="min-w-0 flex-1 break-words [overflow-wrap:anywhere] text-sm font-medium">
          {item.name}
        </h3>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`复制标题 ${item.name}`}
          title="复制标题"
          onClick={() => void copyName()}
        >
          <HugeiconsIcon icon={Copy01Icon} size={12} />
        </Button>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">{item.source}</p>
      <AssetSummary summary={item.summary} />
      <button
        type="button"
        className="mt-2 block w-full break-all text-left text-[10px] text-muted-foreground hover:text-foreground hover:underline"
        aria-label={`打开目录 ${item.path}`}
        onClick={() => {
          if (!window.getSelection()?.toString()) void openFolder();
        }}
      >
        {item.path}
      </button>
    </article>
  );
}

function RecommendedCard({
  item,
  installed,
  installing,
  note,
  onInstall,
}: {
  item: RecommendedPiPlugin;
  installed: boolean;
  installing: boolean;
  note?: string;
  onInstall: (packageName: string) => void;
}) {
  const command = `pi install ${recommendedInstallSpec(item.package)}`;
  return (
    <article className="flex min-h-32 flex-col rounded-lg border border-border bg-card p-3 shadow-sm">
      <h3 className="truncate text-sm font-medium">{item.name}</h3>
      <p className="mt-1 font-mono text-[10px] text-muted-foreground">
        {item.package}
      </p>
      <AssetSummary summary={item.summary} />
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button
          size="xs"
          disabled={installed || installing}
          onClick={() => onInstall(item.package)}
        >
          {installed ? "已安装" : installing ? "安装中…" : "安装"}
        </Button>
        <Button
          size="xs"
          variant="secondary"
          onClick={() => void openExternalUrl(item.repoUrl)}
        >
          仓库
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void writeText(command)}
        >
          复制命令
        </Button>
      </div>
      {note ? (
        <p className="mt-2 line-clamp-4 break-words text-[10px] text-muted-foreground">
          {note}
        </p>
      ) : null}
    </article>
  );
}

function PluginCatalog({
  items,
  specs,
  busy,
  error,
  installing,
  installNote,
  onInstall,
}: {
  items: PiAsset[];
  specs: string[];
  busy: boolean;
  error: string;
  installing: string | null;
  installNote: Record<string, string>;
  onInstall: (packageName: string) => void;
}) {
  const installed = [
    ...items.map((item) => ({ name: item.name })),
    ...specs.map((spec) => ({ spec })),
  ];
  return (
    <Tabs
      defaultValue="installed"
      className="flex min-h-0 flex-1 flex-col gap-0"
    >
      <TabsList
        variant="line"
        className="h-8 w-full shrink-0 justify-start rounded-none border-b border-border px-3 sm:px-4"
      >
        <TabsTrigger value="installed" className="flex-none px-3 text-xs">
          已安装
        </TabsTrigger>
        <TabsTrigger value="recommended" className="flex-none px-3 text-xs">
          推荐安装
        </TabsTrigger>
      </TabsList>
      <TabsContent
        value="installed"
        className="reader-scrollbar min-h-0 flex-1 overflow-auto p-3 sm:p-4"
      >
        {!busy && !error && !items.length ? (
          <p className="py-12 text-center text-xs text-muted-foreground">
            暂无已安装插件
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <AssetCard key={`${item.source}:${item.path}`} item={item} />
            ))}
          </div>
        )}
      </TabsContent>
      <TabsContent
        value="recommended"
        className="reader-scrollbar min-h-0 flex-1 overflow-auto p-3 sm:p-4"
      >
        <p className="mb-3 text-[10px] text-muted-foreground">
          公开 npm
          插件，一点安装。自研扩展不在此列出。正在跑的线程需新开或重启后加载。
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {RECOMMENDED_PI_PLUGINS.map((item) => (
            <RecommendedCard
              key={item.package}
              item={item}
              installed={isRecommendedPluginInstalled(item.package, installed)}
              installing={installing === item.package}
              note={installNote[item.package]}
              onInstall={onInstall}
            />
          ))}
        </div>
      </TabsContent>
    </Tabs>
  );
}

async function installRecommendedPackage(
  packageName: string,
  refresh: () => Promise<void>,
): Promise<string> {
  const output = await installPiPackage(packageName);
  await refresh();
  return output || "已写入 Pi 配置。正在跑的线程需新开或重启后才会加载。";
}

/** 展示技能或插件清单；插件页额外提供公开包的一点安装。 */
export function PiAssetsPanel({ kind }: { kind: "skills" | "plugins" }) {
  const [items, setItems] = useState<PiAsset[]>([]);
  const [specs, setSpecs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);
  const [installNote, setInstallNote] = useState<Record<string, string>>({});
  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setItems(await listPiAssets(kind));
      if (kind === "plugins")
        setSpecs(await listPiPackageSpecs().catch(() => []));
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  }, [kind]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const onInstall = async (packageName: string) => {
    setInstalling(packageName);
    setInstallNote((current) => ({ ...current, [packageName]: "" }));
    try {
      const note = await installRecommendedPackage(packageName, refresh);
      setInstallNote((current) => ({ ...current, [packageName]: note }));
    } catch (value) {
      setInstallNote((current) => ({
        ...current,
        [packageName]: String(value),
      }));
    } finally {
      setInstalling(null);
    }
  };
  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label={kind === "skills" ? "技能展示" : "插件展示"}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-3 sm:px-4">
        <h2 className="flex-1 text-sm font-medium">
          {kind === "skills" ? "技能" : "插件"}
        </h2>
        <span className="text-xs text-muted-foreground">{items.length} 项</span>
        <Button
          variant="ghost"
          size="icon-sm"
          title="刷新"
          aria-label="刷新"
          disabled={busy || installing !== null}
          onClick={() => void refresh()}
        >
          <HugeiconsIcon
            icon={Refresh01Icon}
            className={busy ? "animate-spin" : ""}
            size={14}
          />
        </Button>
      </div>
      {error && (
        <p role="alert" className="px-3 pt-3 text-xs text-amber-600 sm:px-4">
          {error}
        </p>
      )}
      {kind === "plugins" ? (
        <PluginCatalog
          items={items}
          specs={specs}
          busy={busy}
          error={error}
          installing={installing}
          installNote={installNote}
          onInstall={onInstall}
        />
      ) : (
        <div className="reader-scrollbar min-h-0 flex-1 overflow-auto p-3 sm:p-4">
          {!busy && !error && !items.length && (
            <p className="py-12 text-center text-xs text-muted-foreground">
              暂无可展示内容
            </p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <AssetCard key={`${item.source}:${item.path}`} item={item} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
