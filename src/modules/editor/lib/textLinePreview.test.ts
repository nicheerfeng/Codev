import { describe, expect, it } from "vitest";
import { collectLineOffsets, formatPreviewBytes } from "./textLinePreview";

describe("text line preview helpers", () => {
  it("shows only a compact total size", () => {
    expect(formatPreviewBytes(0)).toBe("0 B");
    expect(formatPreviewBytes(26.6 * 1024 * 1024)).toBe("26.6 MB");
  });

  it("maps selected rows to disk offsets in order", () => {
    const lines = [{ offset: 0 }, { offset: 10 }, { offset: 20 }];
    expect(collectLineOffsets([2, 0], lines)).toEqual([0, 20]);
  });
});
