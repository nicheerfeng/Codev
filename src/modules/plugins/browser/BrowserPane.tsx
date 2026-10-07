import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { CodeIcon, Refresh01Icon, SentIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWorkbench } from "../workbench/store";
import {
  browserClose,
  browserHide,
  browserInspect,
  browserReload,
  browserSetBounds,
  browserShow,
  onBrowserTitle,
  type BrowserBounds,
} from "./native";

function pageUrl(value: string): string {
  const text = value.trim();
  if (!text) return "about:blank";
  if (/^[a-z]+:/i.test(text)) return text;
  return `https://${text}`;
}

function readBounds(node: HTMLElement): BrowserBounds {
  const box = node.getBoundingClientRect();
  const clip = node.closest("[data-workbench-body]")?.getBoundingClientRect();
  const x = Math.max(0, box.left, clip?.left ?? 0);
  const y = Math.max(0, box.top, clip?.top ?? 0);
  return {
    x,
    y,
    width: Math.max(
      0,
      Math.min(box.right, clip?.right ?? window.innerWidth, window.innerWidth) -
        x,
    ),
    height: Math.max(
      0,
      Math.min(
        box.bottom,
        clip?.bottom ?? window.innerHeight,
        window.innerHeight,
      ) - y,
    ),
  };
}

export function BrowserPane({
  visible = true,
  webviewId = "default",
}: {
  visible?: boolean;
  webviewId?: string;
}) {
  const moving = useWorkbench((state) => state.moving);
  const surface = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState("https://example.com");
  const [url, setUrl] = useState("https://example.com");
  const [error, setError] = useState("");

  const open = () => {
    const node = surface.current;
    if (!node || !visible || moving) return;
    const next = pageUrl(address);
    setAddress(next);
    setUrl(next);
    setError("");
    useWorkbench
      .getState()
      .rename("browser", webviewId, next.replace(/^https?:\/\//, ""));
    void browserShow(next, readBounds(node), webviewId, true).catch((failure) =>
      setError(String(failure)),
    );
  };

  useEffect(() => {
    if (!visible || moving) {
      void browserHide(webviewId).catch(console.error);
      return;
    }
    const node = surface.current;
    if (!node) return;
    let frame = 0;
    let lastBounds = "";
    let shown = false;
    const sync = () => {
      const bounds = readBounds(node);
      const overlay = document.querySelector(
        '[role="dialog"], [role="alertdialog"], [role="menu"]',
      );
      const blocked =
        document.hidden ||
        bounds.width < 1 ||
        bounds.height < 1 ||
        !!overlay?.getClientRects().length;
      if (blocked && shown) {
        shown = false;
        void browserHide(webviewId).catch(console.error);
      } else if (!blocked) {
        const signature = JSON.stringify(bounds);
        if (!shown) {
          shown = true;
          void browserShow(url, bounds, webviewId).catch((failure) =>
            setError(String(failure)),
          );
        } else if (signature !== lastBounds) {
          void browserSetBounds(bounds, webviewId).catch((failure) =>
            setError(String(failure)),
          );
        }
        lastBounds = signature;
      }
      frame = requestAnimationFrame(sync);
    };
    sync();
    return () => {
      cancelAnimationFrame(frame);
      void browserHide(webviewId).catch(console.error);
    };
  }, [visible, moving, webviewId, url]);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void onBrowserTitle((title) => {
      const text = title.trim();
      if (text) useWorkbench.getState().rename("browser", webviewId, text);
    }, webviewId)
      .then((unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      })
      .catch((failure) => setError(String(failure)));
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [webviewId]);

  useEffect(
    () => () => {
      void browserClose(webviewId).catch(console.error);
    },
    [webviewId],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 p-2">
        <Input
          value={address}
          aria-label="网址"
          placeholder="输入网址后回车"
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") open();
          }}
        />
        <Button
          size="icon-xs"
          variant="ghost"
          title="打开网址"
          aria-label="打开网址"
          onClick={open}
        >
          <HugeiconsIcon icon={SentIcon} size={13} />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          title="刷新当前页面"
          aria-label="刷新当前页面"
          onClick={() =>
            void browserReload(webviewId).catch((failure) =>
              setError(String(failure)),
            )
          }
        >
          <HugeiconsIcon icon={Refresh01Icon} size={13} />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          title="检查此网页元素"
          aria-label="检查此网页元素"
          onClick={() =>
            void browserInspect(webviewId).catch((failure) =>
              setError(String(failure)),
            )
          }
        >
          <HugeiconsIcon icon={CodeIcon} size={13} />
        </Button>
      </div>
      <div ref={surface} className="min-h-0 flex-1 bg-card" />
      {error && (
        <p className="border-t border-border/60 p-2 text-[10px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
