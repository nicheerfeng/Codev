import type { EditorThemeId } from "@/modules/settings/store";
import type { Extension } from "@codemirror/state";
import {
  catppuccinLatte,
  catppuccinMocha,
  codiumDark,
  codiumLight,
} from "./cmThemes";

export const EDITOR_THEME_EXT: Record<EditorThemeId, Extension> = {
  "codium-dark": codiumDark,
  "codium-light": codiumLight,
  "catppuccin-mocha": catppuccinMocha,
  "catppuccin-latte": catppuccinLatte,
};
