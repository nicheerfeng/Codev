import { describe, expect, it } from "vitest";
import {
  capturePiRuntimeConfig,
  planPiRuntimeConfig,
  piRuntimeAdaptationNotice,
} from "./runtimeConfig";
import type { PiModel } from "./types";

const a: PiModel = {
  provider: "one",
  id: "a",
  resourceFingerprint: "sha256:a",
};
const b: PiModel = {
  provider: "two",
  id: "b",
  resourceFingerprint: "sha256:b",
};

function binding(catalog: PiModel[] = [a, b]) {
  return capturePiRuntimeConfig(1, catalog, catalog, a);
}

describe("Pi runtime configuration decisions", () => {
  it("uses catalog fingerprints even when RPC models contain no Codev metadata", () => {
    const runtime = binding();
    expect(
      planPiRuntimeConfig(runtime, [a, b], { provider: "one", id: "a" }),
    ).toEqual({ kind: "reuse" });
    expect(runtime.loadedModels[0].resourceFingerprint).toBe("sha256:a");
  });

  it("ignores display metadata, unrelated resources and thinking changes", () => {
    const runtime = binding();
    runtime.thinkingLevel = "xhigh";
    const updated = [
      { ...a, name: "Renamed", contextWindow: 500000 },
      { ...b, resourceFingerprint: "sha256:changed" },
    ];
    expect(planPiRuntimeConfig(runtime, updated, a)).toEqual({ kind: "reuse" });
  });

  it("switches between already loaded models without replacing startup fingerprints", () => {
    const runtime = binding();
    const snapshot = runtime.loadedModels;
    expect(planPiRuntimeConfig(runtime, [a, b], b)).toEqual({
      kind: "switch-model",
      model: b,
    });
    runtime.model = b;
    expect(runtime.loadedModels).toBe(snapshot);
    expect(planPiRuntimeConfig(runtime, [a, b], a)).toEqual({
      kind: "switch-model",
      model: a,
    });
  });

  it("reloads changed resources even when the model identifier stays the same", () => {
    const changed = { ...a, resourceFingerprint: "sha256:new-auth-or-api" };
    expect(planPiRuntimeConfig(binding(), [changed, b], a)).toEqual({
      kind: "restart",
      reason: "resource-changed",
    });
  });

  it("reloads a newly configured model absent from this process", () => {
    expect(planPiRuntimeConfig(binding([a]), [a, b], b)).toEqual({
      kind: "restart",
      reason: "model-added",
    });
  });

  it("does not restart repeatedly for a configured model rejected during startup", () => {
    const runtime = capturePiRuntimeConfig(1, [a, b], [a], a);
    expect(() => planPiRuntimeConfig(runtime, [a, b], b)).toThrow(
      "检查模型配置和认证信息",
    );
    expect(
      planPiRuntimeConfig(
        runtime,
        [a, { ...b, resourceFingerprint: "sha256:fixed" }],
        b,
      ),
    ).toEqual({ kind: "restart", reason: "resource-changed" });
  });

  it("rejects removed or unknown selections instead of silently choosing another model", () => {
    expect(() => planPiRuntimeConfig(binding(), [b], a)).toThrow(
      "重新选择模型",
    );
    expect(() =>
      planPiRuntimeConfig(binding(), [a], { provider: "missing", id: "a" }),
    ).toThrow("重新选择模型");
  });

  it("keeps native built-in models distinct from missing configured resources", () => {
    const runtime = capturePiRuntimeConfig(1, [], [a, b], a);
    expect(planPiRuntimeConfig(runtime, [], b)).toEqual({
      kind: "switch-model",
      model: b,
    });
  });

  it("captures fingerprints by value and reports only actual restarts", () => {
    const original = { ...a };
    const runtime = binding([original]);
    original.resourceFingerprint = "sha256:later";
    expect(runtime.loadedModels[0].resourceFingerprint).toBe("sha256:a");
    expect(piRuntimeAdaptationNotice({ kind: "unchanged" })).toBe("");
    expect(piRuntimeAdaptationNotice({ kind: "model-switched" })).toBe("");
    expect(
      piRuntimeAdaptationNotice({
        kind: "runtime-restarted",
        reason: "resource-changed",
      }),
    ).toContain("已重新连接");
  });
});
