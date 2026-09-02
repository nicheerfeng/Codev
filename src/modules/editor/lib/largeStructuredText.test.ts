import { describe, expect, it } from "vitest";
import {
  FULL_EDITOR_MAX_BYTES,
  shouldUseLargeStructuredTextPreview,
} from "./largeStructuredText";

describe("shouldUseLargeStructuredTextPreview", () => {
  it("keeps JSON and JSONL in the editor through 50 MB", () => {
    expect(
      shouldUseLargeStructuredTextPreview("data.jsonl", FULL_EDITOR_MAX_BYTES),
    ).toBe(false);
  });

  it("routes JSON and JSONL above 50 MB to paged text", () => {
    expect(
      shouldUseLargeStructuredTextPreview(
        "data.JSON",
        FULL_EDITOR_MAX_BYTES + 1,
      ),
    ).toBe(true);
    expect(
      shouldUseLargeStructuredTextPreview(
        "data.jsonl",
        100 * 1024 * 1024,
      ),
    ).toBe(true);
  });

  it("does not change other file types", () => {
    expect(
      shouldUseLargeStructuredTextPreview("data.csv", 100 * 1024 * 1024),
    ).toBe(false);
  });
});
