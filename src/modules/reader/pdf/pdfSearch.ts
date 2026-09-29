import type {
  TextSearchHandle,
  TextSearchOptions,
  TextSearchStatus,
} from "@/modules/editor/lib/textSearch";

export type PdfFindEvent = {
  source?: unknown;
  state?: number;
  rawQuery?: string | string[] | null;
  matchesCount?: { current: number; total: number };
};

export type PdfSearchBus = {
  on: (name: string, listener: (event: PdfFindEvent) => void) => void;
  off: (name: string, listener: (event: PdfFindEvent) => void) => void;
  dispatch: (name: string, data: object) => void;
};

/** 每个阅读器独享搜索状态；加载前的查询在 pagesinit 后重放。 */
export function createPdfSearchSession() {
  let query = "";
  let options: TextSearchOptions = { caseSensitive: false };
  let status: TextSearchStatus = { count: 0, index: 0 };
  let bus: PdfSearchBus | null = null;
  let detach: (() => void) | null = null;
  const listeners = new Set<(value: TextSearchStatus) => void>();
  const publish = (value: TextSearchStatus) => {
    status = value;
    for (const listener of listeners) listener(value);
  };
  const find = (type = "", previous = false) => {
    bus?.dispatch("find", {
      source: handle,
      type,
      query,
      caseSensitive: options.caseSensitive,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
  };
  const handle: TextSearchHandle = {
    setQuery(next, nextOptions = { caseSensitive: false }) {
      if (query === next && options.caseSensitive === nextOptions.caseSensitive)
        return;
      query = next;
      options = { ...nextOptions };
      publish({ count: 0, index: 0, busy: Boolean(query) });
      if (query) find();
      else bus?.dispatch("findbarclose", { source: handle });
    },
    findNext() {
      if (query && bus) find("again");
    },
    findPrevious() {
      if (query && bus) find("again", true);
    },
    clearQuery() {
      query = "";
      bus?.dispatch("findbarclose", { source: handle });
      publish({ count: 0, index: 0 });
    },
    getSearchStatus: () => status,
    subscribeSearchStatus(listener) {
      listeners.add(listener);
      listener(status);
      return () => {
        listeners.delete(listener);
      };
    },
    replaceCurrent: async () => 0,
    replaceAll: async () => 0,
  };
  return {
    handle,
    connect(nextBus: PdfSearchBus, controller: unknown) {
      detach?.();
      bus = nextBus;
      const onResult = (event: PdfFindEvent) => {
        if (!query || event.source !== controller) return;
        if (event.rawQuery != null && event.rawQuery !== query) return;
        const matches = event.matchesCount;
        publish({
          count: matches?.total ?? status.count,
          index: matches?.current ?? status.index,
          busy: event.state === 3,
        });
      };
      nextBus.on("updatefindmatchescount", onResult);
      nextBus.on("updatefindcontrolstate", onResult);
      detach = () => {
        nextBus.off("updatefindmatchescount", onResult);
        nextBus.off("updatefindcontrolstate", onResult);
      };
      if (query) find();
    },
    disconnect() {
      detach?.();
      detach = null;
      bus = null;
      publish({ count: 0, index: 0 });
    },
  };
}
