import type { PiModel } from "./types";

export type PiModelIdentity = Pick<PiModel, "provider" | "id">;
export type PiLoadedModel = PiModelIdentity & {
  resourceFingerprint: string | null;
};

export type PiRuntimeConfig = {
  readonly runtimeId: number;
  readonly loadedModels: readonly PiLoadedModel[];
  readonly configuredModels: readonly PiLoadedModel[];
  model: PiModelIdentity | null;
  /** Last acknowledged request; native clamping never changes the composer. */
  thinkingLevel: string | null;
};

export type PiRuntimePlan =
  | { kind: "reuse" }
  | { kind: "switch-model"; model: PiModelIdentity }
  | { kind: "restart"; reason: "resource-changed" | "model-added" };

export type PiRuntimeAdaptation =
  | { kind: "unchanged" | "model-switched" | "deferred" }
  | { kind: "runtime-restarted"; reason: "resource-changed" | "model-added" };

export function samePiModel(
  left: PiModelIdentity | null | undefined,
  right: PiModelIdentity | null | undefined,
): boolean {
  return (
    !!left &&
    !!right &&
    left.provider === right.provider &&
    left.id === right.id
  );
}

/** Only catalog records may supply a resource fingerprint, never RPC view models. */
export function piResourceFingerprint(model: PiModel): string {
  return (
    model.resourceFingerprint ??
    JSON.stringify([model.baseUrl ?? "", model.keyFingerprint ?? ""])
  );
}

export function capturePiRuntimeConfig(
  runtimeId: number,
  catalog: readonly PiModel[],
  available: readonly PiModel[],
  model: PiModelIdentity | null,
): PiRuntimeConfig {
  const loaded = [...available];
  if (model && !loaded.some((item) => samePiModel(item, model)))
    loaded.push({ provider: model.provider, id: model.id });
  return {
    runtimeId,
    loadedModels: loaded.map((item) => {
      const resource = catalog.find((entry) => samePiModel(entry, item));
      return {
        provider: item.provider,
        id: item.id,
        resourceFingerprint: resource ? piResourceFingerprint(resource) : null,
      };
    }),
    configuredModels: catalog.map((item) => ({
      provider: item.provider,
      id: item.id,
      resourceFingerprint: piResourceFingerprint(item),
    })),
    model: model ? { provider: model.provider, id: model.id } : null,
    thinkingLevel: null,
  };
}

/** Compare the selected target against this process's immutable startup snapshot. */
export function planPiRuntimeConfig(
  runtime: PiRuntimeConfig,
  catalog: readonly PiModel[],
  selected: PiModelIdentity | null,
): PiRuntimePlan {
  if (!selected) return { kind: "reuse" };
  const resource = catalog.find((item) => samePiModel(item, selected));
  const loaded = runtime.loadedModels.find((item) =>
    samePiModel(item, selected),
  );
  if (!resource) {
    // Native built-in/extension models have no models.json fingerprint.
    if (!loaded || loaded.resourceFingerprint !== null)
      throw new Error("当前选择的模型已不在配置目录中，请重新选择模型");
  } else {
    const configured = runtime.configuredModels.find((item) =>
      samePiModel(item, selected),
    );
    if (
      configured &&
      configured.resourceFingerprint !== piResourceFingerprint(resource)
    )
      return { kind: "restart", reason: "resource-changed" };
    if (!loaded) {
      if (configured)
        throw new Error("Pi 未加载当前模型，请检查模型配置和认证信息");
      return { kind: "restart", reason: "model-added" };
    }
    if (loaded.resourceFingerprint !== piResourceFingerprint(resource))
      return { kind: "restart", reason: "resource-changed" };
  }
  return samePiModel(runtime.model, selected)
    ? { kind: "reuse" }
    : { kind: "switch-model", model: selected };
}

export function piRuntimeAdaptationNotice(result: PiRuntimeAdaptation): string {
  if (result.kind !== "runtime-restarted") return "";
  return result.reason === "resource-changed"
    ? "当前模型的请求配置已更新，已重新连接 Pi"
    : "新模型配置已加载，已重新连接 Pi";
}
