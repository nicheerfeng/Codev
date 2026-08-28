import { describe, expect, it } from "vitest";
import { resolveEditorThemeId } from "./resolveEditorTheme";
import type { Theme } from "./types";

const custom: Theme = {
  id: "my-theme",
  name: "Mine",
  editorTheme: { dark: "codium-dark", light: "codium-light" },
  variants: { dark: {}, light: {} },
};

describe("resolveEditorThemeId", () => {
  it("returns an explicit pref unchanged, ignoring app theme", () => {
    expect(resolveEditorThemeId("codium-dark", "catppuccin", [], "dark")).toBe(
      "codium-dark",
    );
    expect(
      resolveEditorThemeId("codium-light", "catppuccin", [], "light"),
    ).toBe("codium-light");
  });

  it("auto follows the builtin app theme pairing per mode", () => {
    expect(resolveEditorThemeId("auto", "codium-dark", [], "dark")).toBe(
      "codium-dark",
    );
    expect(resolveEditorThemeId("auto", "codium-dark", [], "light")).toBe(
      "codium-light",
    );
  });

  it("auto falls back to the other mode when a pairing is missing", () => {
    const darkOnly: Theme = {
      id: "dark-only",
      name: "Dark only",
      editorTheme: { dark: "codium-dark" },
      variants: { dark: {} },
    };
    expect(resolveEditorThemeId("auto", "dark-only", [darkOnly], "light")).toBe(
      "codium-dark",
    );
  });

  it("auto prefers a matching custom theme over builtins", () => {
    expect(resolveEditorThemeId("auto", "my-theme", [custom], "dark")).toBe(
      "codium-dark",
    );
    expect(resolveEditorThemeId("auto", "my-theme", [custom], "light")).toBe(
      "codium-light",
    );
  });

  it("auto with an unknown app theme uses the default theme pairing", () => {
    expect(resolveEditorThemeId("auto", "does-not-exist", [], "dark")).toBe(
      "codium-dark",
    );
  });

  it("auto falls back to a neutral theme when the pairing is invalid", () => {
    const bad: Theme = {
      id: "bad",
      name: "Bad",
      editorTheme: { dark: "not-a-real-theme" },
      variants: { dark: {} },
    };
    expect(resolveEditorThemeId("auto", "bad", [bad], "dark")).toBe(
      "codium-dark",
    );
    expect(resolveEditorThemeId("auto", "bad", [bad], "light")).toBe(
      "codium-light",
    );
  });
});
