export type JsonObject = Record<string, unknown>;
export type ModelDraft = { key: string; text: string };
export type ProviderDraft = {
  key: string;
  name: string;
  text: string;
  hasModels: boolean;
  models: ModelDraft[];
};
export type ModelDashboard = {
  root: JsonObject;
  hasProviders: boolean;
  providers: ProviderDraft[];
};

export const PROVIDER_EXAMPLE = JSON.stringify(
  {
    baseUrl: "https://api.example.com/v1",
    api: "openai-completions",
    apiKey: "替换为你的 API Key",
  },
  null,
  2,
);
export const MODEL_EXAMPLE = JSON.stringify(
  {
    id: "替换为服务商提供的模型 ID",
    name: "我的模型",
  },
  null,
  2,
);

/** 从已有模型复制配置并生成不重复的新 ID，不更改原卡片。 */
export function duplicateModel(
  provider: ProviderDraft,
  model: ModelDraft,
): ModelDraft {
  const config = parseConfigObject(model.text, "待复制模型");
  const ids = new Set(
    provider.models.map((item) => {
      try {
        return parseConfigObject(item.text, "模型").id;
      } catch {
        return null;
      }
    }),
  );
  const base =
    typeof config.id === "string" && config.id.trim() ? config.id : "model";
  let id = `${base}-copy`;
  let index = 2;
  while (ids.has(id)) id = `${base}-copy-${index++}`;
  return {
    key: crypto.randomUUID(),
    text: JSON.stringify({ ...config, id }, null, 2),
  };
}

/** 仅将目标卡片合入已保存快照，其他未保存编辑保持在内存。 */
export function mergeCardSave(
  draft: ModelDashboard,
  saved: ModelDashboard,
  providerKey: string,
  modelKey?: string,
): ModelDashboard {
  const source = draft.providers.find((item) => item.key === providerKey);
  if (!source) throw new Error("服务商已移除");
  const previous = saved.providers.find((item) => item.key === providerKey);
  let provider: ProviderDraft;
  if (modelKey) {
    const model = source.models.find((item) => item.key === modelKey);
    if (!model) throw new Error("模型已移除");
    const models = previous?.models ?? [];
    provider = {
      ...(previous ?? { ...source, models: [] }),
      hasModels: true,
      models: models.some((item) => item.key === modelKey)
        ? models.map((item) => (item.key === modelKey ? model : item))
        : [...models, model],
    };
  } else
    provider = {
      ...source,
      models: previous?.models ?? [],
      hasModels: previous?.hasModels ?? source.hasModels,
    };
  return {
    ...saved,
    hasProviders: true,
    providers: previous
      ? saved.providers.map((item) =>
          item.key === providerKey ? provider : item,
        )
      : [...saved.providers, provider],
  };
}

/** 校验 JSON 对象并给出对应配置位置，不修改任何字段。 */
export function parseConfigObject(text: string, location: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${location}：JSON 格式错误`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${location}必须是 JSON 对象`);
  return value as JsonObject;
}

/** 参考 models-dashboard：在内存中拆分 provider 公共配置和逐模型 JSON。 */
export function splitModelConfig(text: string): ModelDashboard {
  const root = parseConfigObject(text, "根节点");
  const { providers, ...rest } = root;
  if (
    providers !== undefined &&
    (!providers || typeof providers !== "object" || Array.isArray(providers))
  )
    throw new Error("providers 必须是对象");
  return {
    root: rest,
    hasProviders: providers !== undefined,
    providers: Object.entries(providers ?? {}).map(([name, value]) => {
      const provider = parseConfigObject(
        JSON.stringify(value),
        `providers.${name}`,
      );
      const { models, ...config } = provider;
      if (models !== undefined && !Array.isArray(models))
        throw new Error(`providers.${name}.models 必须是数组`);
      return {
        key: crypto.randomUUID(),
        name,
        text: JSON.stringify(config, null, 2),
        hasModels: models !== undefined,
        models: ((models as unknown[]) ?? []).map((model) => ({
          key: crypto.randomUUID(),
          text: JSON.stringify(model, null, 2),
        })),
      };
    }),
  };
}

/** 聚合所有编辑卡片，保留未知字段和仅覆盖内置模型的 provider。 */
export function joinModelConfig(
  dashboard: ModelDashboard,
  validate = true,
): string {
  const names = new Set<string>();
  const providers = Object.fromEntries(
    dashboard.providers.map((provider) => {
      const name = provider.name.trim();
      if (!name || names.has(name))
        throw new Error(`Provider 名称为空或重复：${name}`);
      names.add(name);
      const config = parseConfigObject(provider.text, `providers.${name}`);
      if ("models" in config)
        throw new Error(`${name} 的 models 请在模型编辑区修改`);
      const ids = new Set<string>();
      const models = provider.models.map((draft, index) => {
        const label = `${name} 第 ${index + 1} 个模型`;
        const model = parseConfigObject(draft.text, label);
        if (validate) {
          if (typeof model.id !== "string" || !model.id.trim())
            throw new Error(`${label}：id 必须填写`);
          if (ids.has(model.id))
            throw new Error(`${name} 的模型 id 重复：${model.id}`);
          ids.add(model.id);
          for (const field of ["contextWindow", "maxTokens"])
            if (
              model[field] !== undefined &&
              (typeof model[field] !== "number" || Number(model[field]) <= 0)
            )
              throw new Error(`${label}：${field} 必须是正数`);
          if (
            model.reasoning !== undefined &&
            typeof model.reasoning !== "boolean"
          )
            throw new Error(`${label}：reasoning 必须是布尔值`);
        }
        return model;
      });
      return [
        name,
        {
          ...config,
          ...(provider.hasModels || models.length ? { models } : {}),
        },
      ];
    }),
  );
  return JSON.stringify(
    {
      ...dashboard.root,
      ...(dashboard.hasProviders || dashboard.providers.length
        ? { providers }
        : {}),
    },
    null,
    2,
  );
}

/** 为模型列表生成即时名称和解析状态，不覆盖未完成的 JSON 输入。 */
export function modelDraftLabel(draft: ModelDraft): {
  title: string;
  detail: string;
  valid: boolean;
} {
  try {
    const model = parseConfigObject(draft.text, "模型");
    const id = typeof model.id === "string" ? model.id : "";
    return {
      title: typeof model.name === "string" ? model.name : id || "未命名模型",
      detail: id || "缺少 id",
      valid: !!id.trim(),
    };
  } catch {
    return { title: "未完成的模型", detail: "JSON 待修正", valid: false };
  }
}
