import { beforeEach, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    /** 返回模拟磁盘中的全部布局值。 */
    async entries() {
      return [...disk.entries()];
    }
    /** 模拟异步文件写入。 */
    async set(key: string, value: unknown) {
      disk.set(key, value);
    }
    /** 模拟提交到磁盘。 */
    async save() {}
  },
}));

beforeEach(() => {
  disk.clear();
  vi.resetModules();
});

it("migrates legacy layout but keeps the file authoritative", async () => {
  disk.set("codev.sidebar.width", "420");
  const old = new Map([
    ["codev.sidebar.width", "260"],
    ["codev.pi.sidebar.collapsed", '["project:a"]'],
    ["unrelated-token", "private"],
  ]);
  const { initUiState, uiState } = await import("./uiState");
  await initUiState({ getItem: (key) => old.get(key) ?? null });
  expect(uiState.getItem("codev.sidebar.width")).toBe("420");
  expect(disk.get("codev.pi.sidebar.collapsed")).toBe('["project:a"]');
  expect(disk.has("unrelated-token")).toBe(false);
});

it("restores the last drag order after reload without browser storage", async () => {
  const first = await import("./uiState");
  await first.initUiState({ getItem: () => null });
  first.uiState.setItem("codev.dock.order", '["pi","terminal","json","diff"]');
  first.uiState.setItem("codev.dock.order", '["json","pi","terminal","diff"]');
  await first.flushUiState();
  vi.resetModules();
  const next = await import("./uiState");
  await next.initUiState({ getItem: () => null });
  expect(next.uiState.getItem("codev.dock.order")).toBe(
    '["json","pi","terminal","diff"]',
  );
});
