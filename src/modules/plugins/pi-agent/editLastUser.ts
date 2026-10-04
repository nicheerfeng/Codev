import type { PiMessageItem, PiViewState } from "./types";

/** 运行已结束时允许编辑最后输入，兼容主动终止及尚无助手回复的情况。 */
export function editableLastUser(view: PiViewState): PiMessageItem | undefined {
  if (view.status !== "idle") return undefined;
  return [...view.items]
    .reverse()
    .find(
      (item): item is PiMessageItem =>
        item.kind === "message" && item.role === "user",
    );
}
