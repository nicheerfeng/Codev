import { describe, expect, it } from "vitest";
import {
  joinModelConfig,
  splitModelConfig,
  modelDraftLabel,
  mergeCardSave,
  duplicateModel,
} from "./modelDashboard";
import { plainStatusText } from "./statusText";

describe("Pi 模型看板", () => {
  it("单模型保存不带入其他卡片未保存或非法的编辑", () => {
    const saved = splitModelConfig(
      '{"customRoot":true,"providers":{"one":{"headers":{"X-Test":"keep"},"models":[{"id":"a"},{"id":"b"}]},"two":{"models":[]}}}',
    );
    const draft = structuredClone(saved);
    const provider = draft.providers[0];
    provider.text = '{"headers":{"X-Test":"changed"}}';
    provider.models[0].text = '{"id":"a","name":"Changed"}';
    provider.models[1].text = "{invalid";
    draft.providers[1].text = "{invalid";
    const merged = mergeCardSave(
      draft,
      saved,
      provider.key,
      provider.models[0].key,
    );
    const data = JSON.parse(joinModelConfig(merged));
    expect(data.providers.one.headers).toEqual({ "X-Test": "keep" });
    expect(data.providers.one.models).toEqual([
      { id: "a", name: "Changed" },
      { id: "b" },
    ]);
    expect(data.customRoot).toBe(true);
    expect(provider.models[1].text).toBe("{invalid");
    expect(JSON.parse(saved.providers[0].models[0].text)).toEqual({ id: "a" });
  });
  it("公共配置单卡保存保留已保存模型，新增服务商单模型保存不捎带其他草稿", () => {
    const saved = splitModelConfig(
      '{"providers":{"one":{"models":[{"id":"a"}]}}}',
    );
    const draft = structuredClone(saved);
    draft.providers[0].name = "renamed";
    draft.providers[0].models = [];
    const meta = JSON.parse(
      joinModelConfig(mergeCardSave(draft, saved, draft.providers[0].key)),
    );
    expect(meta.providers.one).toBeUndefined();
    expect(meta.providers.renamed.models).toEqual([{ id: "a" }]);
    const added = splitModelConfig(
      '{"providers":{"new":{"api":"openai-responses","models":[{"id":"x"},{"id":"y"}]}}}',
    ).providers[0];
    draft.providers.push(added);
    const result = JSON.parse(
      joinModelConfig(
        mergeCardSave(draft, saved, added.key, added.models[0].key),
      ),
    );
    expect(result.providers.new.models).toEqual([{ id: "x" }]);
    expect(result.providers.new.api).toBe("openai-responses");
    expect(result.providers.one.models).toEqual([{ id: "a" }]);
  });
  it("复制模型连续生成唯一 ID，保留完整能力字段和原模型", () => {
    const provider = splitModelConfig(
      '{"providers":{"p":{"models":[{"id":"a","custom":true},{"id":"a-copy"}]}}}',
    ).providers[0];
    const result = duplicateModel(provider, provider.models[0]);
    expect(JSON.parse(result.text)).toEqual({ id: "a-copy-2", custom: true });
    expect(result.key).not.toBe(provider.models[0].key);
    expect(JSON.parse(provider.models[0].text).id).toBe("a");
  });
  it("切换和聚合完整保留未知字段及仅 modelOverrides 配置", () => {
    const config = {
      customRoot: { enabled: true },
      providers: {
        local: {
          baseUrl: "http://localhost",
          headers: { "X-Test": "$TOKEN" },
          customOption: [1, 2],
          models: [
            {
              id: "a",
              compat: { customFlag: true },
              cost: { input: 2 },
              reasoning: true,
            },
          ],
        },
        builtin: { modelOverrides: { core: { contextWindow: 100000 } } },
      },
    };
    const split = splitModelConfig(JSON.stringify(config));
    expect(JSON.parse(joinModelConfig(split))).toEqual(config);
    split.providers[0].models[0].text = '{"id":"b","maxTokens":8192}';
    const saved = JSON.parse(joinModelConfig(split));
    expect(saved.providers.local.models[0].id).toBe("b");
    expect(saved.providers.local.customOption).toEqual([1, 2]);
    expect(saved.providers.builtin.models).toBeUndefined();
  });
  it("拒绝重复模型和无效草稿，不能静默丢失错误卡片", () => {
    const split = splitModelConfig(
      '{"providers":{"test":{"models":[{"id":"a"},{"id":"a"}]}}}',
    );
    expect(() => joinModelConfig(split)).toThrow("重复");
    split.providers[0].models[1].text = "{";
    expect(() => joinModelConfig(split)).toThrow("JSON 格式错误");
    expect(modelDraftLabel(split.providers[0].models[1]).valid).toBe(false);
  });
  it("空配置往返不增补不必要的字段", () => {
    expect(joinModelConfig(splitModelConfig("{}"))).toBe("{}");
    expect(
      JSON.parse(joinModelConfig(splitModelConfig('{"providers":{"a":{}}}'))),
    ).toEqual({ providers: { a: {} } });
  });
  it("拒绝在公共配置重复放置 models，允许原文修复", () => {
    const split = splitModelConfig('{"providers":{"a":{"models":[]}}}');
    split.providers[0].text = '{"models":[]}';
    expect(() => joinModelConfig(split)).toThrow("模型编辑区");
    expect(() => splitModelConfig('{"providers":[]}')).toThrow("providers");
  });
});

describe("Pi 状态文字", () => {
  it("清理截图中的 ANSI 颜色和 OSC 链接，不删除中文与普通方括号", () => {
    expect(
      plainStatusText(
        "[full-access] · \x1b[38;2;102;102;102mLSP Inactive\x1b[39m · \x1b[38;2;102;102;102mDesktop\x1b[39m",
      ),
    ).toBe("[full-access] · LSP Inactive · Desktop");
    expect(
      plainStatusText("\x1b]8;;https://example.com\x07中文\x1b]8;;\x07"),
    ).toBe("中文");
    expect(plainStatusText("\x9b31m就绪\x9b0m")).toBe("就绪");
  });
});
