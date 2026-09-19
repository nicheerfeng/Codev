import type { Input, Item, Session } from "./protocol";

/** 空闲时仅定位全会话最后一条用户输入，忽略尾部压缩等系统轮次。 */
export function editableLastUser(session: Session) {
  if (
    !session.loaded ||
    session.busy ||
    session.sending ||
    session.stopping ||
    session.queue.length ||
    session.requests.length
  )
    return undefined;
  for (let index = session.thread.turns.length - 1; index >= 0; index--) {
    const turn = session.thread.turns[index];
    const item = [...turn.items]
      .reverse()
      .find((item) => item.type === "userMessage");
    if (item) return { turn, item };
  }
  return undefined;
}

/** 将同轮较早输入还原为原生输入，编辑末条时保留其文字和附件。 */
export function originalInputs(item: Item): Input[] {
  const parts = (item.content ?? []) as Array<{
    type: string;
    text?: string;
    path?: string;
    url?: string;
    name?: string;
  }>;
  return parts.flatMap((part): Input[] => {
    if (part.type === "text" && part.text != null)
      return [{ type: "text", text: part.text, text_elements: [] }];
    if (part.type === "image" && part.url)
      return [{ type: "image", url: part.url }];
    if (part.type === "localImage" && part.path)
      return [{ type: "localImage", path: part.path }];
    if (part.type === "skill" && part.path && part.name)
      return [{ type: "skill", path: part.path, name: part.name }];
    return [];
  });
}
