import { cn } from "@/lib/utils";
import { MarkdownLink } from "@/modules/markdown/MarkdownLink";
import { MarkdownTable } from "@/modules/markdown/MarkdownTable";
import { ZoomableImage } from "@/modules/reader/ZoomableImage";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type ComponentProps,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import { useForgeStore } from "./store";

const GITHUB_IMAGE_HOST_RE =
  /^https:\/\/([^/]*\.)?(github\.com|githubusercontent\.com|github-production-user-asset[^/]*\.amazonaws\.com)$/i;

export function normalizeForgeImageUrl(raw?: string): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return "";
  if (trimmed.startsWith("/")) return `https://github.com${trimmed}`;
  return trimmed;
}

export function isProxyableGithubImage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      GITHUB_IMAGE_HOST_RE.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function parseGithubRepoFromRemote(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  let host = "";
  let path = "";
  if (trimmed.startsWith("git@")) {
    const rest = trimmed.slice(4);
    const colon = rest.indexOf(":");
    if (colon < 0) return null;
    host = rest.slice(0, colon);
    path = rest.slice(colon + 1);
  } else {
    try {
      const parsed = new URL(trimmed);
      host = parsed.hostname;
      path = parsed.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  }
  if (!host.toLowerCase().includes("github")) return null;
  const cleaned = path.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[0]}/${parts[1]}`;
}

export const ForgeImage = memo(function ForgeImage({
  src,
  alt,
  className,
  node: _node,
  onError,
  ...props
}: ComponentProps<"img"> & { node?: unknown }) {
  const normalized = normalizeForgeImageUrl(src);
  const [resolvedSrc, setResolvedSrc] = useState(normalized);
  const [proxying, setProxying] = useState(false);
  const [failed, setFailed] = useState(false);
  const triedProxyRef = useRef(false);

  useEffect(() => {
    setResolvedSrc(normalized);
    setProxying(false);
    setFailed(false);
    triedProxyRef.current = false;
  }, [normalized]);

  const handleImageError = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement, Event>) => {
      onError?.(e);
      if (
        !triedProxyRef.current &&
        normalized &&
        isProxyableGithubImage(normalized)
      ) {
        triedProxyRef.current = true;
        setProxying(true);
        void useForgeStore
          .getState()
          .fetchForgeImage(normalized)
          .then((dataUrl) => {
            setResolvedSrc(dataUrl);
            setProxying(false);
          })
          .catch(() => {
            setProxying(false);
            setFailed(true);
          });
        return;
      }
      setFailed(true);
    },
    [normalized, onError],
  );

  if (proxying) {
    return (
      <span className="my-1.5 flex h-24 w-48 animate-pulse items-center justify-center rounded border border-border/50 bg-muted/40 text-[10px] text-muted-foreground">
        正在加载 GitHub 图片…
      </span>
    );
  }

  if (failed || !resolvedSrc) {
    return (
      <button
        type="button"
        onClick={() =>
          normalized && void openUrl(normalized).catch(() => undefined)
        }
        className="my-1.5 inline-flex items-center gap-1 rounded border border-border/60 bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
        title={normalized || "图片不可用"}
      >
        <span>图片加载失败{alt ? ` (${alt})` : ""} · 点击在浏览器查看</span>
      </button>
    );
  }

  return (
    <ZoomableImage
      {...props}
      src={resolvedSrc}
      alt={alt}
      onError={handleImageError}
      className={cn(
        "my-1.5 max-h-[360px] max-w-full rounded border border-border/50 object-contain",
        className,
      )}
    />
  );
});

const forgeMarkdownComponents = {
  a: MarkdownLink,
  img: ForgeImage,
  table: MarkdownTable,
};

const forgeStreamdownControls = {
  code: { copy: true, download: false },
  table: false,
} as const;

export const ForgeMarkdown = memo(function ForgeMarkdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <Streamdown
      className={cn(
        "markdown-rendered forge-markdown select-text text-[11.5px] leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
      mode="static"
      parseIncompleteMarkdown={false}
      controls={forgeStreamdownControls}
      components={forgeMarkdownComponents}
    >
      {content}
    </Streamdown>
  );
});
