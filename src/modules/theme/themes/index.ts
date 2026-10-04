import { DEFAULT_THEME_ID, type Theme } from "../types";
import { catppuccin } from "./catppuccin";
import { codiumDark } from "./codium-dark";
import { codevDefault } from "./codev-default";

const BUILTIN: Theme[] = [codevDefault, codiumDark, catppuccin];

const BY_ID = new Map<string, Theme>(BUILTIN.map((t) => [t.id, t]));

export function listBuiltinThemes(): Theme[] {
  return BUILTIN;
}

export function getBuiltinTheme(id: string): Theme | undefined {
  return BY_ID.get(id);
}

export function getDefaultTheme(): Theme {
  return BY_ID.get(DEFAULT_THEME_ID) ?? BUILTIN[0];
}
