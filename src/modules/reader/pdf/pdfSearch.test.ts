import { describe, expect, it, vi } from "vitest";
import {
  createPdfSearchSession,
  type PdfFindEvent,
  type PdfSearchBus,
} from "./pdfSearch";

function createBus() {
  const listeners = new Map<string, Set<(event: PdfFindEvent) => void>>();
  const bus: PdfSearchBus = {
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)?.add(listener);
    },
    off(name, listener) {
      listeners.get(name)?.delete(listener);
    },
    dispatch: vi.fn(),
  };
  return {
    bus,
    emit(name: string, event: PdfFindEvent) {
      for (const callback of listeners.get(name) ?? []) callback(event);
    },
  };
}

describe("PDF 与顶部搜索栏的会话适配", () => {
  it("在文档就绪后重放提前输入的中文关键词", () => {
    const search = createPdfSearchSession();
    const { bus } = createBus();
    search.handle.setQuery("折算");
    expect(search.handle.getSearchStatus().busy).toBe(true);
    search.connect(bus, {});
    expect(bus.dispatch).toHaveBeenCalledWith(
      "find",
      expect.objectContaining({ query: "折算", highlightAll: true }),
    );
  });
  it("回传真实命中数，并保持同词 setQuery 幂等", () => {
    const search = createPdfSearchSession();
    const { bus, emit } = createBus();
    const controller = {};
    const listener = vi.fn();
    search.handle.subscribeSearchStatus(listener);
    search.connect(bus, controller);
    search.handle.setQuery("折算");
    emit("updatefindcontrolstate", {
      source: controller,
      rawQuery: "折算",
      state: 0,
      matchesCount: { current: 2, total: 8 },
    });
    expect(listener).toHaveBeenLastCalledWith({
      count: 8,
      index: 2,
      busy: false,
    });
    search.handle.setQuery("折算");
    expect(bus.dispatch).toHaveBeenCalledTimes(1);
    expect(search.handle.getSearchStatus().index).toBe(2);
  });
  it("向同一 PDF 派发前后导航，不修改文档地址", () => {
    const search = createPdfSearchSession();
    const { bus } = createBus();
    search.connect(bus, {});
    search.handle.setQuery("test");
    search.handle.findNext();
    expect(bus.dispatch).toHaveBeenLastCalledWith(
      "find",
      expect.objectContaining({ type: "again", findPrevious: false }),
    );
    search.handle.findPrevious();
    expect(bus.dispatch).toHaveBeenLastCalledWith(
      "find",
      expect.objectContaining({ type: "again", findPrevious: true }),
    );
  });
  it("清空后忽略延迟结果，重新搜索同词仍可执行", () => {
    const search = createPdfSearchSession();
    const { bus, emit } = createBus();
    const controller = {};
    search.connect(bus, controller);
    search.handle.setQuery("折算");
    search.handle.clearQuery();
    emit("updatefindmatchescount", {
      source: controller,
      matchesCount: { current: 1, total: 6 },
    });
    expect(search.handle.getSearchStatus()).toEqual({ count: 0, index: 0 });
    expect(bus.dispatch).toHaveBeenLastCalledWith(
      "findbarclose",
      expect.any(Object),
    );
    search.handle.setQuery("折算");
    expect(bus.dispatch).toHaveBeenLastCalledWith(
      "find",
      expect.objectContaining({ query: "折算" }),
    );
  });
  it("隔离两个阅读器实例，包括打开相同路径的情况", () => {
    const first = createPdfSearchSession();
    const second = createPdfSearchSession();
    const a = createBus();
    const b = createBus();
    first.connect(a.bus, {});
    second.connect(b.bus, {});
    first.handle.setQuery("第一份");
    expect(a.bus.dispatch).toHaveBeenCalledTimes(1);
    expect(b.bus.dispatch).not.toHaveBeenCalled();
    expect(second.handle.getSearchStatus()).toEqual({ count: 0, index: 0 });
  });
  it("解绑后不接收旧结果，重连后保留查询和顶部订阅", () => {
    const search = createPdfSearchSession();
    const a = createBus();
    const controller = {};
    search.connect(a.bus, controller);
    search.handle.setQuery("折算");
    search.disconnect();
    a.emit("updatefindmatchescount", {
      source: controller,
      matchesCount: { current: 1, total: 9 },
    });
    expect(search.handle.getSearchStatus().count).toBe(0);
    const b = createBus();
    search.connect(b.bus, {});
    expect(b.bus.dispatch).toHaveBeenCalledWith(
      "find",
      expect.objectContaining({ query: "折算" }),
    );
  });
  it("拒绝旧查询状态，PDF 替换接口为只读", async () => {
    const search = createPdfSearchSession();
    const { bus, emit } = createBus();
    const controller = {};
    search.connect(bus, controller);
    search.handle.setQuery("新词");
    emit("updatefindcontrolstate", {
      source: controller,
      state: 0,
      rawQuery: "旧词",
      matchesCount: { current: 1, total: 99 },
    });
    expect(search.handle.getSearchStatus().count).toBe(0);
    expect(await search.handle.replaceAll("覆盖")).toBe(0);
    expect(await search.handle.replaceCurrent("覆盖")).toBe(0);
  });
});
