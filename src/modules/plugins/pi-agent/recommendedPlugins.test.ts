import { describe, expect, it } from "vitest";
import {
  isRecommendedPluginInstalled,
  RECOMMENDED_PI_PLUGINS,
  recommendedInstallSpec,
} from "./recommendedPlugins";

describe("recommended Pi plugins", () => {
  it("uses npm specs and never recommends first-party extensions", () => {
    expect(recommendedInstallSpec("pi-lens")).toBe("npm:pi-lens");
    expect(
      RECOMMENDED_PI_PLUGINS.every(
        (item) => item.package.includes("/") || item.package.startsWith("pi-"),
      ),
    ).toBe(true);
    expect(
      RECOMMENDED_PI_PLUGINS.some((item) =>
        item.package.includes("extensions"),
      ),
    ).toBe(false);
  });

  it("matches installed packages by name or npm spec", () => {
    expect(
      isRecommendedPluginInstalled("pi-lens", [
        { name: "pi-lens", spec: "npm:pi-lens" },
      ]),
    ).toBe(true);
    expect(
      isRecommendedPluginInstalled("pi-lens", [{ name: "pi-subagents" }]),
    ).toBe(false);
  });
});
