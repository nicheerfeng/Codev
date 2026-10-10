import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../store", () => ({
  usePluginStore: {
    getState: () => ({ enabled: { browser: true } }),
    subscribe: vi.fn(() => () => undefined),
  },
}));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
import { useWorkbench, type WorkbenchSource } from "./store";

const source = (id: string): WorkbenchSource => ({
  kind: "terminal",
  id,
  title: id,
});
beforeEach(() =>
  useWorkbench.setState({
    slots: [],
    targets: {},
    visible: false,
    moving: false,
  }),
);
describe("workbench slots", () => {
  it("deduplicates sources, fills empty slots and does not auto-grow", () => {
    const state = useWorkbench.getState();
    expect(state.add(source("1"))).toBe(false);
    state.append();
    expect(state.add(source("1"))).toBe(true);
    expect(state.add(source("1"))).toBe(true);
    expect(useWorkbench.getState().slots).toHaveLength(1);
    for (let id = 2; id <= 6; id++) {
      state.append();
      expect(state.add(source(String(id)))).toBe(true);
    }
    expect(state.add(source("7"))).toBe(false);
    expect(useWorkbench.getState().slots).toHaveLength(6);
  });
  it("swaps original source references without cloning them", () => {
    const first = source("1");
    const second = source("2");
    useWorkbench.setState({ slots: [first, second] });
    useWorkbench.getState().swap(0, 1);
    expect(useWorkbench.getState().slots[0]).toBe(second);
    expect(useWorkbench.getState().slots[1]).toBe(first);
  });
  it("releases a deleted source without shifting remaining slot identities", () => {
    const second = source("2");
    useWorkbench.setState({ slots: [source("1"), second] });
    useWorkbench.getState().release("terminal", "1");
    expect(useWorkbench.getState().slots).toEqual([null, second]);
    useWorkbench.getState().remove(0);
    expect(useWorkbench.getState().slots).toEqual([null, second]);
  });
});
