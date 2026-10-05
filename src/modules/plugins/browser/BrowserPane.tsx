import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  CodeIcon,
  PlusSignIcon,
  Refresh01Icon,
  SentIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  browserHide,
  browserInspect,
  browserReload,
  browserSetBounds,
  browserShow,
  onBrowserTitle,
  type BrowserBounds,
} from "./native";

type Page = {
  id: number;
  title: string;
  address: string;
  url: string;
};

function pageUrl(value: string): string {
  const text = value.trim();
  if (!text) return "about:blank";
  if (/^[a-z]+:/i.test(text)) return text;
  return `https://${text}`;
}

function createPage(id: number, url = "https://example.com"): Page {
  return { id, title: "新标签", address: url, url };
}

function readBounds(node: HTMLElement): BrowserBounds {
  const box = node.getBoundingClientRect();
  return {
    x: box.left,
    y: box.top,
    width: Math.max(1, box.width),
    height: Math.max(1, box.height),
  };
}

export function BrowserPane({ visible = true }: { visible?: boolean }) {
  const surface = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<Page[]>(() => [createPage(1)]);
  const [active, setActive] = useState(1);
  const [nextId, setNextId] = useState(2);
  const [error, setError] = useState("");
  const page = pages.find((item) => item.id === active) ?? pages[0];

  const update = (id: number, patch: Partial<Page>) => {
    setPages((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };

  const showPage = (url: string) => {
    const node = surface.current;
    if (!node || !visible) return;
    void browserShow(url, readBounds(node)).catch((failure: unknown) =>
      setError(String(failure)),
    );
  };

  const open = () => {
    if (!page) return;
    const url = pageUrl(page.address);
    update(page.id, { url, title: url.replace(/^https?:\/\//, "") });
    setError("");
    showPage(url);
  };

  const add = () => {
    const id = nextId;
    const next = createPage(id);
    setNextId((value) => value + 1);
    setPages((current) => [...current, next]);
    setActive(id);
    setError("");
    showPage(next.url);
  };

  const close = (id: number) => {
    const next = pages.filter((item) => item.id !== id);
    const remaining = next.length ? next : [createPage(id)];
    const selected =
      remaining.find((item) => item.id === active) ??
      remaining[remaining.length - 1];
    setPages(remaining);
    setActive(selected.id);
  };

  useEffect(() => {
    if (!visible) {
      void browserHide();
      return;
    }
    if (page) showPage(page.url);
    const node = surface.current;
    if (!node) return;
    const sync = () => void browserSetBounds(readBounds(node));
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
      void browserHide();
    };
  }, [visible, page?.id, page?.url]);

  useEffect(() => {
    let stop: UnlistenFn | undefined;
    void onBrowserTitle((title) => {
      const text = title.trim();
      if (!text) return;
      setPages((current) =>
        current.map((item) =>
          item.id === active ? { ...item, title: text } : item,
        ),
      );
    }).then((unlisten) => {
      stop = unlisten;
    });
    return () => {
      stop?.();
    };
  }, [active]);

  useEffect(() => () => void browserHide(), []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1">
        {pages.map((item) => (
          <span
            key={item.id}
            className={`inline-flex h-6 max-w-40 items-center rounded-sm ${
              item.id === page?.id
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            <button
              type="button"
              className="min-w-0 truncate px-2 text-[11px]"
              onClick={() => {
                setActive(item.id);
                setError("");
                showPage(item.url);
              }}
            >
              {item.title}
            </button>
            {pages.length > 1 && (
              <button
                type="button"
                className="mr-1 flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground"
                title="关闭此标签"
                aria-label={`关闭 ${item.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  close(item.id);
                }}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={10} />
              </button>
            )}
          </span>
        ))}
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={add}
          title="新建标签"
          aria-label="新建标签"
        >
          <HugeiconsIcon icon={PlusSignIcon} size={12} />
        </Button>
      </div>
      {page && (
        <div className="flex items-center gap-1 border-b border-border/60 p-2">
          <Input
            value={page.address}
            aria-label="网址"
            placeholder="输入网址后回车"
            onChange={(event) =>
              update(page.id, { address: event.target.value })
            }
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
              void browserReload().catch((failure: unknown) =>
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
              void browserInspect().catch((failure: unknown) =>
                setError(String(failure)),
              )
            }
          >
            <HugeiconsIcon icon={CodeIcon} size={13} />
          </Button>
        </div>
      )}
      <div ref={surface} className="min-h-0 flex-1 bg-card" />
      {error && (
        <p className="border-t border-border/60 p-2 text-[10px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

type UnlistenFn = () => void;
