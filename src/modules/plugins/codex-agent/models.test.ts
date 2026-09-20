import { expect, it } from "vitest";
import { canonicalModel, mergeModels } from "./models";
import { itemText, reduceNotification, sessionFromThread } from "./protocol";

it("normalizes known routing aliases only when the base exists", () => {
  expect(canonicalModel("gpt-5.5-codex5", [{ model: "gpt-5.5" }])).toBe("gpt-5.5");
  expect(canonicalModel("gpt-5.5-codex5", [])).toBe("gpt-5.5-codex5");
  expect(canonicalModel("deepseek-v4-flash", [{ model: "deepseek-v4" }])).toBe("deepseek-v4-flash");
});

it("does not substitute built-in models for an empty resource catalog", () => {
  expect(mergeModels([{ id: "gpt", model: "gpt", displayName: "GPT", isDefault: true, supportedReasoningEfforts: [], defaultReasoningEffort: "" }], [])).toEqual([]);
});

it("merges third-party IDs without borrowing GPT reasoning capabilities", () => {
  const native = { id: "gpt", model: "gpt", displayName: "GPT", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high" };
  const models = mergeModels([native], [{ id: "gpt" }, { id: "deepseek-v4-flash", name: "DS" }]);
  expect(models).toHaveLength(2);
  expect(models[0]).toBe(native);
  expect(models[1]).toMatchObject({ model: "deepseek-v4-flash", displayName: "DS", supportedReasoningEfforts: [], defaultReasoningEffort: "" });
});
it("renders real search actions and updates running state", () => {
  const session = sessionFromThread({ id: "s", name: null, preview: "", cwd: "D:/qa", updatedAt: 0, turns: [] });
  const updated = reduceNotification(session, "item/started", { turnId: "t", item: { id: "w", type: "webSearch", query: "DS news", action: { type: "search", queries: ["DS news", "release"] } } });
  const item = updated.thread.turns[0].items[0];
  expect(item.status).toBe("inProgress");
  expect(itemText(item)).toBe("搜索 · DS news · release");
  expect(itemText({ id: "w", type: "webSearch", action: { type: "open_page", url: "https://example.com" } })).toBe("打开网页 · https://example.com");
});


it("keeps only channel models in channel order and deduplicates IDs", () => {
  const native = { id: "gpt", model: "gpt", displayName: "GPT", isDefault: true, supportedReasoningEfforts: [], defaultReasoningEffort: "" };
  expect(mergeModels([native], [{ id: "ds" }, { id: "ds" }, { id: "other" }]).map(model => model.model)).toEqual(["ds", "other"]);
});
