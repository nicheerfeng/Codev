import { describe, expect, it } from "vitest";
import { createNativeFileDragGate } from "./nativeFileDrag";

describe("native file drag gate", () => {
  it("ignores text-selection drags that never carry paths", () => {
    const gate = createNativeFileDragGate();
    expect(
      gate.phase({ type: "enter", paths: [], position: { x: 1, y: 1 } }),
    ).toBe("ignore");
    expect(gate.phase({ type: "over", position: { x: 1, y: 1 } })).toBe(
      "ignore",
    );
    expect(gate.phase({ type: "leave" })).toBe("ignore");
    expect(
      gate.phase({ type: "drop", paths: [], position: { x: 1, y: 1 } }),
    ).toBe("ignore");
  });

  it("keeps hover only after a file enter, then clears on leave", () => {
    const gate = createNativeFileDragGate();
    expect(
      gate.phase({
        type: "enter",
        paths: ["D:/a.py"],
        position: { x: 1, y: 1 },
      }),
    ).toBe("hover");
    expect(gate.phase({ type: "over", position: { x: 2, y: 2 } })).toBe(
      "hover",
    );
    expect(gate.phase({ type: "leave" })).toBe("leave");
    expect(gate.phase({ type: "over", position: { x: 3, y: 3 } })).toBe(
      "ignore",
    );
  });

  it("drops files even if enter was skipped, but ignores empty-path drops", () => {
    const gate = createNativeFileDragGate();
    expect(
      gate.phase({
        type: "drop",
        paths: ["D:/a.py"],
        position: { x: 1, y: 1 },
      }),
    ).toBe("drop");
    expect(
      gate.phase({
        type: "drop",
        paths: [],
        position: { x: 1, y: 1 },
      }),
    ).toBe("ignore");
  });
});
