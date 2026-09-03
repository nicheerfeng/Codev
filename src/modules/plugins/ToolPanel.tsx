import { useState } from "react";
import { JsonFormatterPane } from "./JsonFormatterPane";
import { TextDiffPane } from "./TextDiffPane";

const MAX_FORMATTER_PANES = 2;

type ToolId = "json" | "diff";

/** 渲染独立插件工具区，最多保留两个横向 JSON 格式化页面。 */
export function ToolPanel({ tool = "json" }: { tool?: ToolId }) {
  const [paneIds, setPaneIds] = useState([1]);

  if (tool === "diff") return <TextDiffPane />;

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
