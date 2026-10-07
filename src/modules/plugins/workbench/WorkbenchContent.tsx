import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { sourceKey, useWorkbench, type WorkbenchSource } from "./store";

/** Moving the host preserves the mounted React tree and the native session. */
export function WorkbenchContent({
  source,
  children,
}: {
  source: WorkbenchSource;
  children: ReactNode;
}) {
  const home = useRef<HTMLDivElement>(null);
  const [host] = useState(() => {
    const node = document.createElement("div");
    node.className = `@container flex h-full min-h-0 min-w-0 flex-col overflow-hidden ${source.kind === "pi" ? "pi-agent" : ""}`;
    if (source.kind === "pi") node.dataset.piViewportKey = source.id;
    if (source.kind === "codex") node.dataset.codexViewportKey = source.id;
    return node;
  });
  const key = sourceKey(source);
  const target = useWorkbench((state) =>
    state.visible ? state.targets[key] : undefined,
  );
  useLayoutEffect(() => {
    (target ?? home.current)?.appendChild(host);
    window.dispatchEvent(new Event("resize"));
    return () => host.remove();
  }, [host, target]);
  return (
    <>
      <div ref={home} className="flex h-full min-h-0 min-w-0 flex-col" />
      {createPortal(children, host)}
    </>
  );
}
