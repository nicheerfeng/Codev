import { describe, expect, it } from "vitest";
import type { PiTranscriptItem } from "./types";
import {
  compactPromptHistory,
  mergePromptHistory,
  nextHistoryIndex,
  prependPrompt,
  shouldRecallNext,
  shouldRecallPrevious,
  textareaCaret,
  userPromptTexts,
} from "./promptHistory";

function user(text: string, id?: string): PiTranscriptItem {
  return {
    id: id ?? text,
    kind: "message",
    role: "user",
    text,
    thinking: "",
    streaming: false,
  };
}

function assistant(text: string, id?: string): PiTranscriptItem {
  return {
    id: id ?? text,
    kind: "message",
    role: "assistant",
    text,
    thinking: "",
    streaming: false,
  };
}

describe("userPromptTexts", () => {
  it("keeps user prompts newest first and skips other items", () => {
    expect(
      userPromptTexts([
        user("先问", "1"),
        assistant("答"),
        user("再问", "2"),
        {
          id: "tool",
          kind: "tool",
          toolCallId: "t",
          name: "bash",
          status: "done",
          args: {},
          output: "",
        },
        user("   ", "blank"),
        user("刚发", "3"),
      ]),
    ).toEqual(["刚发", "再问", "先问"]);
  });

  it("drops consecutive duplicates after trim", () => {
    expect(
      userPromptTexts([user("同一条"), assistant("x"), user("同一条")]),
    ).toEqual(["同一条"]);
  });
});

describe("prependPrompt", () => {
  it("inserts a new prompt and ignores consecutive repeats", () => {
    expect(prependPrompt(["旧"], "新")).toEqual(["新", "旧"]);
    expect(prependPrompt(["新", "旧"], "新")).toEqual(["新", "旧"]);
    expect(prependPrompt([], "  ")).toEqual([]);
  });
});

describe("mergePromptHistory", () => {
  it("lets a just-sent prompt appear before transcript catches up", () => {
    expect(mergePromptHistory(["刚发"], [user("上一句")])).toEqual([
      "刚发",
      "上一句",
    ]);
  });

  it("does not duplicate once transcript contains the same text", () => {
    expect(
      mergePromptHistory(["刚发", "上一句"], [user("上一句"), user("刚发")]),
    ).toEqual(["刚发", "上一句"]);
  });
});

describe("compactPromptHistory", () => {
  it("caps at 100 newest entries", () => {
    const texts = Array.from({ length: 120 }, (_, index) => `p${index}`);
    const compacted = compactPromptHistory(texts);
    expect(compacted).toHaveLength(100);
    expect(compacted[0]).toBe("p0");
    expect(compacted[99]).toBe("p99");
  });
});

describe("textareaCaret", () => {
  it("reports first-line column and last-line index", () => {
    expect(textareaCaret("ab\ncd", 1)).toEqual({
      line: 0,
      column: 1,
      lineCount: 2,
    });
    expect(textareaCaret("ab\ncd", 5)).toEqual({
      line: 1,
      column: 2,
      lineCount: 2,
    });
  });
});

describe("shouldRecallPrevious", () => {
  it("yields to the slash command menu", () => {
    expect(
      shouldRecallPrevious({
        showCommands: true,
        browsing: false,
        text: "",
        caret: 0,
      }),
    ).toBe(false);
  });

  it("recalls from an empty box or the start of the first line", () => {
    expect(
      shouldRecallPrevious({
        showCommands: false,
        browsing: false,
        text: "",
        caret: 0,
      }),
    ).toBe(true);
    expect(
      shouldRecallPrevious({
        showCommands: false,
        browsing: false,
        text: "hello",
        caret: 0,
      }),
    ).toBe(true);
    expect(
      shouldRecallPrevious({
        showCommands: false,
        browsing: false,
        text: "hello",
        caret: 3,
      }),
    ).toBe(false);
  });

  it("keeps recalling while already browsing the first line", () => {
    expect(
      shouldRecallPrevious({
        showCommands: false,
        browsing: true,
        text: "older\nline",
        caret: 3,
      }),
    ).toBe(true);
    expect(
      shouldRecallPrevious({
        showCommands: false,
        browsing: true,
        text: "older\nline",
        caret: 8,
      }),
    ).toBe(false);
  });
});

describe("shouldRecallNext", () => {
  it("only moves history on the last line while browsing", () => {
    expect(
      shouldRecallNext({
        showCommands: false,
        browsing: false,
        text: "",
        caret: 0,
      }),
    ).toBe(false);
    expect(
      shouldRecallNext({
        showCommands: false,
        browsing: true,
        text: "a\nb",
        caret: 0,
      }),
    ).toBe(false);
    expect(
      shouldRecallNext({
        showCommands: false,
        browsing: true,
        text: "a\nb",
        caret: 3,
      }),
    ).toBe(true);
  });
});

describe("nextHistoryIndex", () => {
  it("walks from the live draft to older entries and back", () => {
    expect(nextHistoryIndex(-1, -1, 2)).toBe(0);
    expect(nextHistoryIndex(0, -1, 2)).toBe(1);
    expect(nextHistoryIndex(1, -1, 2)).toBeNull();
    expect(nextHistoryIndex(0, 1, 2)).toBe(-1);
    expect(nextHistoryIndex(-1, 1, 2)).toBeNull();
    expect(nextHistoryIndex(-1, -1, 0)).toBeNull();
  });
});
