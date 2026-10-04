import { describe, expect, it } from "vitest";
import { INITIAL_PI_VIEW_STATE, piViewReducer } from "./reducer";
import {
  activitySummary,
  buildTimelineBlocks,
  currentActivity,
} from "./timeline";
import { hasVisibleTranscriptText } from "./transcriptVisibility";
import type { PiEventEnvelope, PiTranscriptItem } from "./types";

const message = (
  id: string,
  role: "assistant" | "user",
  text?: string,
): PiTranscriptItem => ({
  id,
  kind: "message",
  role,
  text: text ?? id,
  thinking: "",
  streaming: false,
});
const thinking = (
  id: string,
  text = "",
  streaming = false,
): PiTranscriptItem => ({
  id,
  kind: "thinking",
  text,
  streaming,
});
const rpc = (event: Record<string, unknown>): PiEventEnvelope => ({
  sessionId: 1,
  stream: "stdout",
  event,
});

describe("Pi 思考展示兼容与最终回复边界", () => {
  it.each([
    "",
    " \t\n",
    "\u200b\u2060\ufeff",
    "\ufffd\ufffd",
    null,
    undefined,
    { encrypted_content: "opaque" },
    123,
  ])("忽略不可显示正文：%j", (text) => {
    expect(hasVisibleTranscriptText(text)).toBe(false);
  });
  it("保留真实思考，包括含部分替换字符和代码的内容", () => {
    for (const text of [
      "检查结果",
      "解析失败后重试",
      "a\ufffdb",
      "```ts\nconst a = 1;\n```",
      "🙂",
    ]) {
      expect(hasVisibleTranscriptText(text)).toBe(true);
    }
  });
  it("空思考不成为步骤，尾部空思考不把最终回复折叠", () => {
    const items = [
      message("user", "user"),
      thinking("empty-before"),
      thinking("real", "检查代码"),
      message("final", "assistant"),
      thinking("empty-after"),
      thinking("zero-width", "\u200b"),
    ];
    const before = JSON.stringify(items);
    const blocks = buildTimelineBlocks(items, false);
    expect(blocks.map((block) => block.kind)).toEqual([
      "item",
      "process",
      "item",
    ]);
    expect(blocks[1]).toMatchObject({ items: [{ id: "real" }] });
    expect(blocks[2]).toMatchObject({ kind: "item", item: { id: "final" } });
    expect(JSON.stringify(items)).toBe(before);
  });
  it("空助手文本同样不遮挡最终回复，用户图片消息不被过滤", () => {
    const user = {
      ...message("user", "user", ""),
      images: [
        { type: "image" as const, mimeType: "image/png", data: "image" },
      ],
    };
    const blocks = buildTimelineBlocks(
      [
        user,
        message("final", "assistant"),
        message("empty", "assistant", "\n"),
      ],
      false,
    );
    expect(blocks.map((block) => block.id)).toEqual(["user", "final"]);
  });
  it("仅有空思考的已完成轮次不制造空过程块", () => {
    expect(buildTimelineBlocks([thinking("empty")], false)).toEqual([]);
    expect(
      buildTimelineBlocks([message("u", "user"), thinking("empty")], false),
    ).toHaveLength(1);
  });
  it("空流式思考仍显示单一运行占位，实际内容到达后才出现步骤", () => {
    const items = [message("u", "user"), thinking("stream", "", true)];
    expect(buildTimelineBlocks(items, true)[1]).toMatchObject({
      kind: "process",
      running: true,
      items: [],
      steps: [],
    });
    expect(
      buildTimelineBlocks(
        [items[0], thinking("stream", "正在核对", true)],
        true,
      )[1],
    ).toMatchObject({ items: [{ id: "stream", text: "正在核对" }] });
  });
  it("活动摘要跳过尾部空思考，不掩盖真实工具状态", () => {
    const tool: PiTranscriptItem = {
      id: "tool",
      kind: "tool",
      toolCallId: "tool",
      name: "read",
      args: {},
      output: "ok",
      status: "done",
    };
    expect(currentActivity([tool, thinking("empty")])).toBe(tool);
    expect(activitySummary(currentActivity([thinking("empty")]))).toBe(
      "等待模型响应",
    );
  });
  it("活动摘要优先显示后续流式思考，不被早先仍运行的并发工具覆盖", () => {
    const tool: PiTranscriptItem = {
      id: "tool",
      kind: "tool",
      toolCallId: "tool",
      name: "bash",
      args: { command: "long-running" },
      output: "",
      status: "running",
      activityOrder: 3,
    };
    const thought = {
      id: "thought",
      kind: "thinking" as const,
      text: "正在归纳刚完成的检查结果",
      streaming: true,
      activityOrder: 4,
    };
    expect(currentActivity([thought, tool])).toBe(thought);
    expect(activitySummary(currentActivity([thought, tool]))).toContain(
      "正在归纳刚完成的检查结果",
    );
  });
  it("同一消息的正文后跟空思考时保持原 contentIndex，不读取 signature", () => {
    const state = piViewReducer(INITIAL_PI_VIEW_STATE, {
      type: "history",
      offset: 0,
      hasMore: false,
      messages: [
        {
          id: "final-entry",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [
              { type: "thinking", thinking: "", thinkingSignature: "opaque" },
              { type: "text", text: "最终回复" },
              { type: "thinking", thinking: { summary: "invalid shape" } },
              null,
            ],
          },
        },
      ],
    });
    expect(state.items.map((item) => item.id)).toEqual([
      "final-entry:0",
      "final-entry:1",
      "final-entry:2",
    ]);
    expect(state.items[2]).toMatchObject({ text: "" });
    expect(buildTimelineBlocks(state.items, false)).toEqual([
      { id: "final-entry:1", kind: "item", item: state.items[1] },
    ]);
  });
  it("空思考不会改变后续流式消息 ID；解析失败提示仍保留", () => {
    let state = piViewReducer(INITIAL_PI_VIEW_STATE, {
      type: "event",
      payload: rpc({
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "",
        },
      }),
    });
    state = piViewReducer(state, {
      type: "event",
      payload: rpc({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 1,
          delta: "最终回复",
        },
      }),
    });
    expect(state.items.map((item) => item.id)).toEqual([
      "message-0:0",
      "message-0:1",
    ]);
    state = piViewReducer(state, {
      type: "event",
      payload: rpc({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [
            { type: "thinking", thinking: "" },
            { type: "text", text: "最终回复" },
            { type: "thinking", thinking: "" },
          ],
        },
      }),
    });
    const completedBlocks = buildTimelineBlocks(state.items, false);
    expect(completedBlocks[completedBlocks.length - 1]).toMatchObject({
      kind: "item",
      item: { id: "message-0:1" },
    });
    state = piViewReducer(state, {
      type: "event",
      payload: rpc({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "解析失败",
          content: [{ type: "thinking", thinking: "" }],
        },
      }),
    });
    expect(state.error).toBe("解析失败");
    const errorBlocks = buildTimelineBlocks(state.items, false);
    expect(errorBlocks[errorBlocks.length - 1]).toMatchObject({
      kind: "item",
      item: { id: "message-0:1" },
    });
  });
});
