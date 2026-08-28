;(() => {
  const params = new URLSearchParams(window.location.search);
  if (window.parent === window || !params.has("codev-preview")) return;

  const CHANNEL = "codev-html-search";
  const MATCH_HIGHLIGHT = "codev-html-search-match";
  const ACTIVE_HIGHLIGHT = "codev-html-search-active";
  const STYLE_ID = "codev-html-search-style";
  const SCROLLBAR_STYLE_ID = "codev-html-scrollbar-style";
  const MAX_MATCHES = 5000;
  let query = "";
  let caseSensitive = false;
  let matches = [];
  let activeIndex = -1;
  let truncated = false;

  /** 判断文本节点是否属于可检索的页面正文。 */
  function isSearchableTextNode(node) {
    const parent = node.parentElement;
    if (!parent || !node.nodeValue || !node.nodeValue.trim()) return false;
    return !parent.closest("script, style, noscript, template");
  }

  /** 注入渲染 HTML 专用的命中高亮样式。 */
  function ensureHighlightStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      ::highlight(${MATCH_HIGHLIGHT}) {
        background-color: rgba(86, 116, 145, 0.32) !important;
      }
      ::highlight(${ACTIVE_HIGHLIGHT}) {
        background-color: rgba(86, 116, 145, 0.52) !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  /** 注入与 Codev 阅读器一致的 HTML 原生滚动条样式。 */
  function ensureScrollbarStyle() {
    let style = document.getElementById(SCROLLBAR_STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = SCROLLBAR_STYLE_ID;
      style.textContent = `
      html, body, body * {
        scrollbar-width: thin !important;
        scrollbar-color: color-mix(in srgb, var(--codev-html-scrollbar-muted) 58%, transparent) var(--codev-html-scrollbar-background) !important;
      }
      html::-webkit-scrollbar,
      body::-webkit-scrollbar,
      body *::-webkit-scrollbar {
        width: 9px !important;
        height: 9px !important;
        background: var(--codev-html-scrollbar-background) !important;
      }
      html::-webkit-scrollbar-button,
      body::-webkit-scrollbar-button,
      body *::-webkit-scrollbar-button,
      html::-webkit-scrollbar-button:single-button,
      body::-webkit-scrollbar-button:single-button,
      body *::-webkit-scrollbar-button:single-button {
        display: none !important;
        width: 0 !important;
        height: 0 !important;
      }
      html::-webkit-scrollbar-thumb,
      body::-webkit-scrollbar-thumb,
      body *::-webkit-scrollbar-thumb {
        border: 2px solid transparent !important;
        border-radius: 999px !important;
        background: color-mix(in srgb, var(--codev-html-scrollbar-muted) 58%, transparent) !important;
        background-clip: padding-box !important;
      }
      html::-webkit-scrollbar-track,
      body::-webkit-scrollbar-track,
      body *::-webkit-scrollbar-track,
      html::-webkit-scrollbar-track-piece,
      body::-webkit-scrollbar-track-piece,
      body *::-webkit-scrollbar-track-piece {
        background: var(--codev-html-scrollbar-background) !important;
      }
    `;
    }
    // 将覆盖样式移动到文档末端，压过页面自身稍后加载的滚动条规则。
    (document.documentElement || document.head).appendChild(style);
  }

  /** 接收 Codev 当前主题色并同步 HTML 页面滚动条。 */
  function setScrollbarTheme(background, mutedForeground) {
    ensureScrollbarStyle();
    const root = document.documentElement;
    root.style.setProperty(
      "--codev-html-scrollbar-background",
      typeof background === "string" && background ? background : "transparent",
    );
    root.style.setProperty(
      "--codev-html-scrollbar-muted",
      typeof mutedForeground === "string" && mutedForeground
        ? mutedForeground
        : "rgba(128, 128, 128, 0.8)",
    );
  }

  /** 清除上一轮检索留下的浏览器范围高亮。 */
  function clearHighlights() {
    if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
    CSS.highlights.delete(MATCH_HIGHLIGHT);
    CSS.highlights.delete(ACTIVE_HIGHLIGHT);
  }

  /** 将当前命中范围提交给浏览器的原生高亮层。 */
  function applyHighlights() {
    clearHighlights();
    if (
      matches.length === 0 ||
      typeof CSS === "undefined" ||
      !("highlights" in CSS) ||
      typeof Highlight === "undefined"
    ) {
      return false;
    }
    try {
      CSS.highlights.set(MATCH_HIGHLIGHT, new Highlight(...matches));
      if (activeIndex >= 0) {
        CSS.highlights.set(
          ACTIVE_HIGHLIGHT,
          new Highlight(matches[activeIndex]),
        );
      }
      return true;
    } catch (error) {
      console.warn("[Codev] HTML search highlight unavailable", error);
      clearHighlights();
      return false;
    }
  }

  /** 从当前渲染页面中收集普通字面量命中范围。 */
  function collectMatches() {
    if (!query || !document.body) return;
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!isSearchableTextNode(node)) continue;
      const text = node.nodeValue || "";
      const haystack = caseSensitive ? text : text.toLocaleLowerCase();
      let offset = 0;
      while (offset <= haystack.length) {
        const found = haystack.indexOf(needle, offset);
        if (found < 0) break;
        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          return;
        }
        const range = document.createRange();
        range.setStart(node, found);
        range.setEnd(node, found + query.length);
        matches.push(range);
        offset = found + Math.max(query.length, 1);
      }
    }
  }

  /** 让当前命中进入 HTML 页面自身的可视区域。 */
  function revealActiveMatch() {
    const range = matches[activeIndex];
    if (!range) return;
    const element =
      range.startContainer.parentElement ||
      range.commonAncestorContainer.parentElement;
    element?.scrollIntoView({ block: "center", inline: "nearest" });
  }

  /** 将当前搜索统计回传给 Codev 顶部搜索框。 */
  function publishStatus() {
    window.parent.postMessage(
      {
        channel: CHANNEL,
        type: "status",
        count: matches.length,
        index: activeIndex >= 0 ? activeIndex + 1 : 0,
        truncated,
      },
      "*",
    );
  }

  /** 更新关键词并重新建立 HTML 文本命中范围。 */
  function setQuery(nextQuery, nextCaseSensitive) {
    query = typeof nextQuery === "string" ? nextQuery : "";
    caseSensitive = nextCaseSensitive === true;
    matches = [];
    activeIndex = -1;
    truncated = false;
    clearHighlights();
    if (!query) {
      publishStatus();
      return;
    }
    try {
      ensureHighlightStyle();
      collectMatches();
      activeIndex = matches.length > 0 ? 0 : -1;
      applyHighlights();
      revealActiveMatch();
    } catch (error) {
      console.warn("[Codev] HTML search failed", error);
    } finally {
      publishStatus();
    }
  }

  /** 在当前命中集合中循环定位上一项或下一项。 */
  function moveMatch(direction) {
    if (matches.length === 0) {
      publishStatus();
      return;
    }
    try {
      activeIndex = (activeIndex + direction + matches.length) % matches.length;
      applyHighlights();
      revealActiveMatch();
    } catch (error) {
      console.warn("[Codev] HTML search navigation failed", error);
    } finally {
      publishStatus();
    }
  }

  /** 通知父页面 bridge 已在当前 HTML 文档中就绪。 */
  function publishReady() {
    window.parent.postMessage({ channel: CHANNEL, type: "ready" }, "*");
  }

  /** 响应父页面握手并保证初始化样式已经安装。 */
  function initializeBridge() {
    ensureHighlightStyle();
    ensureScrollbarStyle();
    publishReady();
  }

  /** 接收父页面发来的统一搜索命令。 */
  function handleSearchMessage(event) {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL) return;
    if (data.type === "query") setQuery(data.query, data.caseSensitive);
    else if (data.type === "next") moveMatch(1);
    else if (data.type === "previous") moveMatch(-1);
    else if (data.type === "clear") setQuery("", false);
    else if (data.type === "scrollbar") {
      setScrollbarTheme(data.background, data.mutedForeground);
    } else if (data.type === "hello") {
      publishReady();
    }
  }

  /** 将 iframe 内的 Ctrl+F 交还给 Codev 顶部搜索。 */
  function handleFindShortcut(event) {
    if (
      !(event.ctrlKey || event.metaKey) ||
      event.altKey ||
      event.key.toLowerCase() !== "f"
    ) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    window.parent.postMessage({ channel: CHANNEL, type: "focus" }, "*");
  }

  window.addEventListener("message", handleSearchMessage);
  window.addEventListener("keydown", handleFindShortcut, true);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeBridge, { once: true });
  } else {
    initializeBridge();
  }
})();
