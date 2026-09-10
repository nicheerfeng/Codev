import { lazy, Suspense, useEffect, useState } from "react";
import { JsonFormatterPane } from "./JsonFormatterPane";
import { TextDiffPane } from "./TextDiffPane";
import { PI_AGENT_PLUGIN_ID, usePluginStore } from "./store";
const PiAgentPane = lazy(() =>
  import("./pi-agent/PiAgentPane").then((module) => ({
    default: module.PiAgentPane,
  })),
);

const MAX_FORMATTER_PANES = 2;

export type ToolId = "json" | "diff" | "pi";

/** 渲染最多两个横向 JSON 格式化页面。 */
function JsonFormatterTool() {
  const [paneIds, setPaneIds] = useState([1]);

  /** 创建第二个独立格式化页，不超过工具页上限。 */
  const addPane = () => {
    setPaneIds((ids) =>
      ids.length >= MAX_FORMATTER_PANES ? ids : [...ids, Math.max(...ids) + 1],
    );
  };

  /** 关闭格式化页并保留至少一个可用工具页。 */
  const closePane = (id: number) => {
    setPaneIds((ids) =>
      ids.length === 1 ? ids : ids.filter((item) => item !== id),
    );
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 max-w-full overflow-hidden bg-card">
      <div className="flex min-h-0 min-w-0 max-w-full flex-1 gap-px overflow-hidden">
        {paneIds.map((id) => (
          <JsonFormatterPane
            key={id}
            onAdd={paneIds.length === 1 ? addPane : undefined}
            onClose={paneIds.length === 2 ? () => closePane(id) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

/** 渲染互相隔离的内置插件页面，并在切换时保留各自状态。 */
export function ToolPanel({
  tool = "json",
  cwd,
  active = true,
}: {
  tool?: ToolId;
  cwd: string | null;
  active?: boolean;
}) {
  const piEnabled = usePluginStore(
    (state) => state.enabled[PI_AGENT_PLUGIN_ID],
  );
  const [piVisited, setPiVisited] = useState(active && tool === "pi");
  useEffect(() => {
    if (active && tool === "pi") setPiVisited(true);
  }, [tool, active]);
  return (
    <div className="relative h-full min-h-0 min-w-0 overflow-hidden bg-card">
      <div
        className={
          tool === "json" ? "absolute inset-0" : "hidden absolute inset-0"
        }
      >
        <JsonFormatterTool />
      </div>
      <div
        className={
          tool === "diff" ? "absolute inset-0" : "hidden absolute inset-0"
        }
      >
        <TextDiffPane />
      </div>
      <div
        className={
          tool === "pi" ? "absolute inset-0" : "hidden absolute inset-0"
        }
      >
        {piVisited && piEnabled && (
          <Suspense
            fallback={
              <div className="p-4 text-xs text-muted-foreground">
                正在加载 Pi Agent…
              </div>
            }
          >
            <PiAgentPane cwd={cwd} active={active && tool === "pi"} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
