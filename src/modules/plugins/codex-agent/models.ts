import type { Model } from "./protocol";

/** 已知渠道别名仅在基础模型可用时归一，不猜测其他模型后缀。 */
export function canonicalModel(id: string, available: Array<{ model: string }>): string {
  const match = id.match(/^(.*)-[A-Za-z]+\d+$/);
  const base = match?.[1] ?? id;
  return available.some(item => item.model === base) ? base : id;
}

/** 合并渠道真实 ID 与原生能力；未知模型不推测思考等级或上下文能力。 */
export function mergeModels(native: Model[], upstream: Array<{ id: string; name?: string }>): Model[] {
  const models = new Map<string, Model>();
  for (const item of upstream) {
    if (!models.has(item.id)) models.set(item.id, native.find(model => model.model === item.id) ?? {
      id: item.id, model: item.id, displayName: item.name?.trim() || item.id,
      isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: "",
    });
  }
  return [...models.values()];
}
