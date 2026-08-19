import type { KeyBinding, ShortcutId } from "@/modules/shortcuts/shortcuts";
import type { Locale } from "@/lib/i18n/types";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";

export type ThemePref = "system" | "light" | "dark";

export const DEFAULT_THEME_ID = "terax-default";

const LEGACY_BUILTIN_THEME_IDS = new Set([
  "claude",
  "kanagawa",
  "kanagawa-dragon",
  "tokyo-night",
  "rose-pine",
  "everforest",
  "nord",
  "gruvbox",
  "dracula",
  "solarized",
  "tide",
  "sage",
  "caffeine",
]);

/** 将已移除的内置主题迁移到新的 Codium Dark，保留自定义主题 id。 */
function migrateBuiltinThemeId(value: string | undefined): string {
  if (!value) return DEFAULT_THEME_ID;
  return LEGACY_BUILTIN_THEME_IDS.has(value) ? "codium-dark" : value;
}

export type BackgroundKind = "none" | "image";

export type TerminalCursorStyle = "bar" | "block" | "underline";

export const EDITOR_THEMES = [
  "codium-dark",
  "codium-light",
  "catppuccin-mocha",
  "catppuccin-latte",
] as const;

export type EditorThemeId = (typeof EDITOR_THEMES)[number];

/** "auto" follows the active app theme's editorTheme pairing (resolved live). */
export const EDITOR_THEME_AUTO = "auto" as const;
export type EditorThemePref = typeof EDITOR_THEME_AUTO | EditorThemeId;

export function isEditorThemeId(v: unknown): v is EditorThemeId {
  return (
    typeof v === "string" && (EDITOR_THEMES as readonly string[]).includes(v)
  );
}

export const EDITOR_THEME_MODE: Record<EditorThemeId, "light" | "dark"> = {
  "codium-dark": "dark",
  "codium-light": "light",
  "catppuccin-mocha": "dark",
  "catppuccin-latte": "light",
};

export const EDITOR_THEME_LABELS: Record<EditorThemeId, string> = {
  "codium-dark": "Codium Dark",
  "codium-light": "Codium Light",
  "catppuccin-mocha": "Catppuccin Mocha",
  "catppuccin-latte": "Catppuccin Latte",
};

export type Preferences = {
  locale: Locale;
  theme: ThemePref;
  themeId: string;
  backgroundKind: BackgroundKind;
  backgroundImageId: string | null;
  backgroundOpacity: number;
  backgroundBlur: number;
  editorTheme: EditorThemePref;
  editorFontSize: number;
  editorWordWrap: boolean;
  editorWordWrapColumn: number;
  showHidden: boolean;
  /** Multi-root workspace: imported folder roots (forward-slash paths). */
  workspaceRoots: string[];
  activeWorkspaceRoot: string | null;
  terminalWebglEnabled: boolean;
  terminalCursorBlink: boolean;
  terminalCursorStyle: TerminalCursorStyle;
  terminalFontFamily: string;
  terminalFontWeight: string;
  terminalShell: string;
  terminalLetterSpacing: number;
  terminalFontSize: number;
  terminalScrollback: number;
  confirmCloseRunningTerminal: boolean;
  lastWslDistro: string | null;
  zoomLevel: number;
  defaultWorkspaceEnv: string;
  shortcuts: Record<ShortcutId, KeyBinding[]>;
  editorAutoSave: boolean;
  editorAutoSaveDelay: number;
};

const STORE_PATH = "terax-settings.json";
const KEY_LOCALE = "locale";
const KEY_THEME = "theme";
const KEY_THEME_ID = "themeId";
const KEY_BG_KIND = "backgroundKind";
const KEY_BG_IMAGE_ID = "backgroundImageId";
const KEY_BG_OPACITY = "backgroundOpacity";
const KEY_BG_BLUR = "backgroundBlur";
const KEY_EDITOR_THEME = "editorTheme";
const KEY_EDITOR_FONT_SIZE = "editorFontSize";
const KEY_EDITOR_WORD_WRAP = "editorWordWrap";
const KEY_EDITOR_WORD_WRAP_COLUMN = "editorWordWrapColumn";
const KEY_SHOW_HIDDEN = "showHidden";
const LEGACY_KEY_SHOW_HIDDEN_DIRS = "showHiddenDirectories";
const KEY_WORKSPACE_ROOTS = "workspaceRoots";
const KEY_ACTIVE_WORKSPACE_ROOT = "activeWorkspaceRoot";
const KEY_WORKSPACE_HISTORY_RESET_VERSION = "workspaceHistoryResetVersion";
const KEY_TERMINAL_WEBGL_ENABLED = "terminalWebglEnabled";
const KEY_TERMINAL_CURSOR_BLINK = "terminalCursorBlink";
const KEY_TERMINAL_CURSOR_STYLE = "terminalCursorStyle";
const KEY_TERMINAL_FONT_FAMILY = "terminalFontFamily";
const KEY_TERMINAL_FONT_WEIGHT = "terminalFontWeight";
const KEY_TERMINAL_SHELL = "terminalShell";
const KEY_TERMINAL_LETTER_SPACING = "terminalLetterSpacing";
const KEY_TERMINAL_FONT_SIZE = "terminalFontSize";
const KEY_TERMINAL_SCROLLBACK = "terminalScrollback";
const KEY_CONFIRM_CLOSE_RUNNING_TERMINAL = "confirmCloseRunningTerminal";
const KEY_LAST_WSL_DISTRO = "lastWslDistro";
const KEY_ZOOM_LEVEL = "zoomLevel";
const KEY_DEFAULT_WORKSPACE_ENV = "defaultWorkspaceEnv";
const KEY_SHORTCUTS = "shortcuts";
const KEY_EDITOR_AUTO_SAVE = "editorAutoSave";
const KEY_EDITOR_AUTO_SAVE_DELAY = "editorAutoSaveDelay";

const TERMINAL_FONT_SIZE_DEFAULT = 14;
const TERMINAL_FONT_SIZE_MIN = 8;
const TERMINAL_FONT_SIZE_MAX = 32;

export const TERMINAL_FONT_SIZES = [
  10, 12, 13, 14, 15, 16, 18, 20, 22, 24,
] as const;

export const EDITOR_FONT_SIZE_DEFAULT = 13;
export const EDITOR_FONT_SIZE_MIN = 8;
export const EDITOR_FONT_SIZE_MAX = 32;
export const EDITOR_FONT_SIZES = [
  10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24,
] as const;

export const EDITOR_WORD_WRAP_COLUMN_DEFAULT = 80;
export const EDITOR_WORD_WRAP_COLUMN_MIN = 20;
export const EDITOR_WORD_WRAP_COLUMN_MAX = 500;

const TERMINAL_SCROLLBACK_DEFAULT = 2000;
const TERMINAL_SCROLLBACK_MIN = 200;
const TERMINAL_SCROLLBACK_MAX = 50_000;
export const TERMINAL_SCROLLBACK_PRESETS = [
  500, 1000, 2000, 5000, 10_000, 25_000,
] as const;

export const DEFAULT_PREFERENCES: Preferences = {
  locale: "zh",
  theme: "system",
  themeId: DEFAULT_THEME_ID,
  backgroundKind: "none",
  backgroundImageId: null,
  backgroundOpacity: 0.5,
  backgroundBlur: 0,
  editorTheme: EDITOR_THEME_AUTO,
  editorFontSize: EDITOR_FONT_SIZE_DEFAULT,
  editorWordWrap: false,
  editorWordWrapColumn: EDITOR_WORD_WRAP_COLUMN_DEFAULT,
  showHidden: false,
  workspaceRoots: [],
  activeWorkspaceRoot: null,
  terminalWebglEnabled: true,
  terminalCursorBlink: false,
  terminalCursorStyle: "bar",
  terminalFontFamily: "",
  terminalFontWeight: "normal",
  terminalShell: "",
  terminalLetterSpacing: 0,
  terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
  terminalScrollback: TERMINAL_SCROLLBACK_DEFAULT,
  confirmCloseRunningTerminal: true,
  lastWslDistro: null,
  zoomLevel: 1.0,
  defaultWorkspaceEnv: "local",
  shortcuts: {} as Record<ShortcutId, KeyBinding[]>,
  editorAutoSave: false,
  editorAutoSaveDelay: 1000,
};

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });
const staleSessionStore = new LazyStore("terax-spaces.json", {
  defaults: {},
  autoSave: 500,
});
const WORKSPACE_HISTORY_RESET_VERSION = 1;

// LazyStore.onChange only fires within the writing process. The settings
// page lives in a separate webview, so writes there never reach the main
// window's subscribers. Mirror every setter through a Tauri event so any
// window can listen.
const PREFS_CHANGED_EVENT = "terax://prefs-changed";

async function writePref<T>(key: string, value: T): Promise<void> {
  await store.set(key, value);
  await store.save();
  await emit(PREFS_CHANGED_EVENT, { key, value });
}

/** 清理本次界面重构前遗留的空间会话记录，仅执行一次。 */
export async function clearStaleWorkspaceHistory(): Promise<boolean> {
  try {
    const version = await store.get<number>(
      KEY_WORKSPACE_HISTORY_RESET_VERSION,
    );
    if (version === WORKSPACE_HISTORY_RESET_VERSION) return false;
    await staleSessionStore.clear();
    await staleSessionStore.save();
    await store.set(
      KEY_WORKSPACE_HISTORY_RESET_VERSION,
      WORKSPACE_HISTORY_RESET_VERSION,
    );
    await store.save();
    return true;
  } catch {
    return false;
  }
}

export async function loadPreferences(): Promise<Preferences> {
  // Single IPC roundtrip — fetching keys individually fans out to one
  // `plugin:store|get` per setting and is the dominant boot cost.
  const entries = await store.entries();
  const map = new Map<string, unknown>(entries);
  const get = <T>(k: string): T | undefined => map.get(k) as T | undefined;
  const storedWorkspaceRoots = get<string[]>(KEY_WORKSPACE_ROOTS);
  const workspaceRoots = normalizeWorkspaceRoots(storedWorkspaceRoots);
  if (
    Array.isArray(storedWorkspaceRoots) &&
    JSON.stringify(storedWorkspaceRoots) !== JSON.stringify(workspaceRoots)
  ) {
    void writePref(KEY_WORKSPACE_ROOTS, workspaceRoots);
  }
  const storedActiveRoot = normalizeWorkspaceRoot(
    get<string | null>(KEY_ACTIVE_WORKSPACE_ROOT),
  );
  const activeWorkspaceRoot =
    storedActiveRoot && workspaceRoots.includes(storedActiveRoot)
      ? storedActiveRoot
      : (workspaceRoots[0] ?? DEFAULT_PREFERENCES.activeWorkspaceRoot);
  if (storedActiveRoot !== activeWorkspaceRoot) {
    void writePref(KEY_ACTIVE_WORKSPACE_ROOT, activeWorkspaceRoot);
  }
  const storedThemeId = get<string>(KEY_THEME_ID);
  const themeId = migrateBuiltinThemeId(storedThemeId);
  if (storedThemeId !== themeId) {
    void writePref(KEY_THEME_ID, themeId);
  }

  return {
    locale: coerceLocale(get<unknown>(KEY_LOCALE)),
    theme: get<ThemePref>(KEY_THEME) ?? DEFAULT_PREFERENCES.theme,
    themeId,
    backgroundKind:
      get<BackgroundKind>(KEY_BG_KIND) ?? DEFAULT_PREFERENCES.backgroundKind,
    backgroundImageId:
      get<string | null>(KEY_BG_IMAGE_ID) ??
      DEFAULT_PREFERENCES.backgroundImageId,
    backgroundOpacity: clampBgOpacity(
      get<number>(KEY_BG_OPACITY) ?? DEFAULT_PREFERENCES.backgroundOpacity,
    ),
    backgroundBlur: clampBlur(
      get<number>(KEY_BG_BLUR) ?? DEFAULT_PREFERENCES.backgroundBlur,
    ),
    editorTheme: ((): EditorThemePref => {
      const stored = get<string>(KEY_EDITOR_THEME);
      if (stored === EDITOR_THEME_AUTO || isEditorThemeId(stored))
        return stored;
      return DEFAULT_PREFERENCES.editorTheme;
    })(),
    editorFontSize: clampEditorFontSize(
      get<number>(KEY_EDITOR_FONT_SIZE) ?? DEFAULT_PREFERENCES.editorFontSize,
    ),
    editorWordWrap:
      get<boolean>(KEY_EDITOR_WORD_WRAP) ?? DEFAULT_PREFERENCES.editorWordWrap,
    editorWordWrapColumn: clampEditorWordWrapColumn(
      get<number>(KEY_EDITOR_WORD_WRAP_COLUMN) ??
        DEFAULT_PREFERENCES.editorWordWrapColumn,
    ),
    showHidden:
      get<boolean>(KEY_SHOW_HIDDEN) ??
      get<boolean>(LEGACY_KEY_SHOW_HIDDEN_DIRS) ??
      DEFAULT_PREFERENCES.showHidden,
    workspaceRoots,
    activeWorkspaceRoot,
    terminalWebglEnabled:
      get<boolean>(KEY_TERMINAL_WEBGL_ENABLED) ??
      DEFAULT_PREFERENCES.terminalWebglEnabled,
    terminalCursorBlink:
      get<boolean>(KEY_TERMINAL_CURSOR_BLINK) ??
      DEFAULT_PREFERENCES.terminalCursorBlink,
    terminalCursorStyle: coerceTerminalCursorStyle(
      get<unknown>(KEY_TERMINAL_CURSOR_STYLE),
    ),
    terminalFontFamily:
      get<string>(KEY_TERMINAL_FONT_FAMILY) ??
      DEFAULT_PREFERENCES.terminalFontFamily,
    terminalFontWeight: coerceFontWeight(
      get<string>(KEY_TERMINAL_FONT_WEIGHT) ??
        DEFAULT_PREFERENCES.terminalFontWeight,
    ),
    terminalShell:
      get<string>(KEY_TERMINAL_SHELL) ?? DEFAULT_PREFERENCES.terminalShell,
    terminalLetterSpacing:
      get<number>(KEY_TERMINAL_LETTER_SPACING) ??
      DEFAULT_PREFERENCES.terminalLetterSpacing,
    terminalFontSize:
      get<number>(KEY_TERMINAL_FONT_SIZE) ??
      DEFAULT_PREFERENCES.terminalFontSize,
    terminalScrollback: clampScrollback(
      get<number>(KEY_TERMINAL_SCROLLBACK) ??
        DEFAULT_PREFERENCES.terminalScrollback,
    ),
    confirmCloseRunningTerminal:
      get<boolean>(KEY_CONFIRM_CLOSE_RUNNING_TERMINAL) ??
      DEFAULT_PREFERENCES.confirmCloseRunningTerminal,
    lastWslDistro:
      get<string | null>(KEY_LAST_WSL_DISTRO) ??
      DEFAULT_PREFERENCES.lastWslDistro,
    zoomLevel: get<number>(KEY_ZOOM_LEVEL) ?? DEFAULT_PREFERENCES.zoomLevel,
    defaultWorkspaceEnv:
      get<string>(KEY_DEFAULT_WORKSPACE_ENV) ??
      DEFAULT_PREFERENCES.defaultWorkspaceEnv,
    shortcuts:
      get<Record<ShortcutId, KeyBinding[]>>(KEY_SHORTCUTS) ??
      DEFAULT_PREFERENCES.shortcuts,
    editorAutoSave:
      get<boolean>(KEY_EDITOR_AUTO_SAVE) ?? DEFAULT_PREFERENCES.editorAutoSave,
    editorAutoSaveDelay: clampAutoSaveDelay(
      get<number>(KEY_EDITOR_AUTO_SAVE_DELAY) ??
        DEFAULT_PREFERENCES.editorAutoSaveDelay,
    ),
  };
}

/** 校验持久化语言值，异常值回退到默认中文。 */
export function coerceLocale(value: unknown): Locale {
  return value === "zh" || value === "en" ? value : DEFAULT_PREFERENCES.locale;
}

/** 持久化界面语言并同步到其他窗口。 */
export async function setLocale(value: Locale): Promise<void> {
  await writePref(KEY_LOCALE, coerceLocale(value));
}

export async function setTheme(value: ThemePref): Promise<void> {
  await writePref(KEY_THEME, value);
}

export async function setThemeId(value: string): Promise<void> {
  await writePref(KEY_THEME_ID, value);
}

/** Slider stores 0..1. Actual rendered opacity is halved in SurfaceLayer
 *  so the image never exceeds 50% — keeps UI/terminal readable at any setting. */
export const BG_OPACITY_RENDER_FACTOR = 0.5;

function clampBgOpacity(v: number): number {
  if (!Number.isFinite(v)) return 0.7;
  return Math.min(1, Math.max(0, v));
}

function clampBlur(v: number): number {
  if (!Number.isFinite(v)) return 16;
  return Math.min(64, Math.max(0, Math.round(v)));
}

/** Normalizes one workspace root: backslashes to forward slashes, trims
 *  trailing slashes (except drive roots like `C:/` and the Unix root `/`),
 *  drops empties. Returns null for blank input. */
export function normalizeWorkspaceRoot(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const norm = raw.replace(/\\/g, "/").trim();
  if (!norm) return null;
  if (norm === "/") return "/";
  const trimmed = norm.replace(/\/+$/, "");
  // `C:` (bare drive letter) is not absolute; keep it out of roots.
  if (!trimmed.includes("/") && trimmed.endsWith(":")) return `${trimmed}/`;
  return trimmed || null;
}

/** 判定旧版本自动加入的裸盘符根，避免启动时重新展开整块磁盘。 */
function isBareDriveRoot(path: string): boolean {
  return /^[A-Za-z]:\/$/.test(path);
}

/** 规范化工作区根目录并清理旧版本的裸盘符根。 */
export function normalizeWorkspaceRoots(
  raw: string[] | null | undefined,
): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const n = normalizeWorkspaceRoot(r);
    if (n && !isBareDriveRoot(n) && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out.filter(
    (path) =>
      !out.some(
        (parent) =>
          parent !== path &&
          path.toLowerCase().startsWith(`${parent.toLowerCase()}/`),
      ),
  );
}

export async function setBackgroundKind(value: BackgroundKind): Promise<void> {
  await writePref(KEY_BG_KIND, value);
}

export async function setBackgroundImageId(
  value: string | null,
): Promise<void> {
  await writePref(KEY_BG_IMAGE_ID, value);
}

export async function setBackgroundOpacity(value: number): Promise<void> {
  await writePref(KEY_BG_OPACITY, clampBgOpacity(value));
}

export async function setBackgroundBlur(value: number): Promise<void> {
  await writePref(KEY_BG_BLUR, clampBlur(value));
}

export async function setEditorTheme(value: EditorThemePref): Promise<void> {
  await writePref(KEY_EDITOR_THEME, value);
}

export async function setWorkspaceRoots(value: string[]): Promise<void> {
  await writePref(KEY_WORKSPACE_ROOTS, normalizeWorkspaceRoots(value));
}

export async function setActiveWorkspaceRoot(
  value: string | null,
): Promise<void> {
  await writePref(KEY_ACTIVE_WORKSPACE_ROOT, normalizeWorkspaceRoot(value));
}

export function clampEditorFontSize(value: number): number {
  if (!Number.isFinite(value)) return EDITOR_FONT_SIZE_DEFAULT;
  return Math.min(
    EDITOR_FONT_SIZE_MAX,
    Math.max(EDITOR_FONT_SIZE_MIN, Math.round(value)),
  );
}

export async function setEditorFontSize(value: number): Promise<void> {
  await writePref(KEY_EDITOR_FONT_SIZE, clampEditorFontSize(value));
}

export async function setEditorWordWrap(value: boolean): Promise<void> {
  await writePref(KEY_EDITOR_WORD_WRAP, value);
}

export function clampEditorWordWrapColumn(value: number): number {
  if (!Number.isFinite(value)) return EDITOR_WORD_WRAP_COLUMN_DEFAULT;
  return Math.min(
    EDITOR_WORD_WRAP_COLUMN_MAX,
    Math.max(EDITOR_WORD_WRAP_COLUMN_MIN, Math.round(value)),
  );
}

export async function setEditorWordWrapColumn(value: number): Promise<void> {
  await writePref(
    KEY_EDITOR_WORD_WRAP_COLUMN,
    clampEditorWordWrapColumn(value),
  );
}

export async function setShowHidden(value: boolean): Promise<void> {
  await writePref(KEY_SHOW_HIDDEN, value);
}

export async function setTerminalWebglEnabled(value: boolean): Promise<void> {
  await writePref(KEY_TERMINAL_WEBGL_ENABLED, value);
}

export async function setTerminalCursorBlink(value: boolean): Promise<void> {
  await writePref(KEY_TERMINAL_CURSOR_BLINK, value);
}

export function coerceTerminalCursorStyle(value: unknown): TerminalCursorStyle {
  return value === "bar" || value === "block" || value === "underline"
    ? value
    : DEFAULT_PREFERENCES.terminalCursorStyle;
}

export async function setTerminalCursorStyle(value: unknown): Promise<void> {
  await writePref(KEY_TERMINAL_CURSOR_STYLE, coerceTerminalCursorStyle(value));
}

export async function setTerminalFontFamily(value: string): Promise<void> {
  await writePref(KEY_TERMINAL_FONT_FAMILY, value.trim());
}

const TERMINAL_FONT_WEIGHT_VALUES = new Set(["normal", "500", "600", "bold"]);

export function coerceFontWeight(value: string): string {
  const v = value.trim();
  return TERMINAL_FONT_WEIGHT_VALUES.has(v) ? v : "normal";
}

export async function setTerminalFontWeight(value: string): Promise<void> {
  await writePref(KEY_TERMINAL_FONT_WEIGHT, coerceFontWeight(value));
}

export async function setTerminalShell(value: string): Promise<void> {
  await writePref(KEY_TERMINAL_SHELL, value.trim());
}

export async function setTerminalLetterSpacing(value: number): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.max(-10, Math.min(10, Math.round(value)))
    : 0;
  await writePref(KEY_TERMINAL_LETTER_SPACING, clamped);
}

export async function setTerminalFontSize(value: number): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.min(
        TERMINAL_FONT_SIZE_MAX,
        Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(value)),
      )
    : TERMINAL_FONT_SIZE_DEFAULT;
  await writePref(KEY_TERMINAL_FONT_SIZE, clamped);
}

function clampScrollback(value: number): number {
  if (!Number.isFinite(value)) return TERMINAL_SCROLLBACK_DEFAULT;
  return Math.min(
    TERMINAL_SCROLLBACK_MAX,
    Math.max(TERMINAL_SCROLLBACK_MIN, Math.round(value)),
  );
}

export async function setTerminalScrollback(value: number): Promise<void> {
  await writePref(KEY_TERMINAL_SCROLLBACK, clampScrollback(value));
}

export async function setConfirmCloseRunningTerminal(
  value: boolean,
): Promise<void> {
  await writePref(KEY_CONFIRM_CLOSE_RUNNING_TERMINAL, value);
}

export async function setLastWslDistro(value: string | null): Promise<void> {
  await writePref(KEY_LAST_WSL_DISTRO, value);
}

export async function setZoomLevel(value: number): Promise<void> {
  await writePref(KEY_ZOOM_LEVEL, value);
}

export const AUTO_SAVE_DELAY_MIN = 100;
export const AUTO_SAVE_DELAY_MAX = 60000;

export function clampAutoSaveDelay(v: number): number {
  if (!Number.isFinite(v)) return 1000;
  return Math.min(
    AUTO_SAVE_DELAY_MAX,
    Math.max(AUTO_SAVE_DELAY_MIN, Math.round(v)),
  );
}

export async function setEditorAutoSave(value: boolean): Promise<void> {
  await writePref(KEY_EDITOR_AUTO_SAVE, value);
}

export async function setEditorAutoSaveDelay(value: number): Promise<void> {
  await writePref(KEY_EDITOR_AUTO_SAVE_DELAY, clampAutoSaveDelay(value));
}

export async function setDefaultWorkspaceEnv(value: string): Promise<void> {
  await writePref(KEY_DEFAULT_WORKSPACE_ENV, value);
}

export async function setShortcuts(
  value: Record<ShortcutId, KeyBinding[]> | {},
): Promise<void> {
  await writePref(KEY_SHORTCUTS, value);
}

export type PrefKey = keyof Preferences;

/** Subscribe to changes from any window (settings → main). */
export async function onPreferencesChange(
  cb: (key: PrefKey, value: unknown) => void,
): Promise<UnlistenFn> {
  const map: Record<string, PrefKey> = {
    [KEY_LOCALE]: "locale",
    [KEY_THEME]: "theme",
    [KEY_THEME_ID]: "themeId",
    [KEY_BG_KIND]: "backgroundKind",
    [KEY_BG_IMAGE_ID]: "backgroundImageId",
    [KEY_BG_OPACITY]: "backgroundOpacity",
    [KEY_BG_BLUR]: "backgroundBlur",
    [KEY_EDITOR_THEME]: "editorTheme",
    [KEY_EDITOR_FONT_SIZE]: "editorFontSize",
    [KEY_EDITOR_WORD_WRAP]: "editorWordWrap",
    [KEY_EDITOR_WORD_WRAP_COLUMN]: "editorWordWrapColumn",
    [KEY_SHOW_HIDDEN]: "showHidden",
    [KEY_WORKSPACE_ROOTS]: "workspaceRoots",
    [KEY_ACTIVE_WORKSPACE_ROOT]: "activeWorkspaceRoot",
    [KEY_TERMINAL_WEBGL_ENABLED]: "terminalWebglEnabled",
    [KEY_TERMINAL_CURSOR_BLINK]: "terminalCursorBlink",
    [KEY_TERMINAL_CURSOR_STYLE]: "terminalCursorStyle",
    [KEY_TERMINAL_FONT_FAMILY]: "terminalFontFamily",
    [KEY_TERMINAL_FONT_WEIGHT]: "terminalFontWeight",
    [KEY_TERMINAL_SHELL]: "terminalShell",
    [KEY_TERMINAL_LETTER_SPACING]: "terminalLetterSpacing",
    [KEY_TERMINAL_FONT_SIZE]: "terminalFontSize",
    [KEY_TERMINAL_SCROLLBACK]: "terminalScrollback",
    [KEY_CONFIRM_CLOSE_RUNNING_TERMINAL]: "confirmCloseRunningTerminal",
    [KEY_LAST_WSL_DISTRO]: "lastWslDistro",
    [KEY_ZOOM_LEVEL]: "zoomLevel",
    [KEY_DEFAULT_WORKSPACE_ENV]: "defaultWorkspaceEnv",
    [KEY_SHORTCUTS]: "shortcuts",
    [KEY_EDITOR_AUTO_SAVE]: "editorAutoSave",
    [KEY_EDITOR_AUTO_SAVE_DELAY]: "editorAutoSaveDelay",
  };
  // Same-process writes still fire onChange immediately; cross-window writes
  // arrive via the Tauri event emitted by writePref().
  const unsubLocal = await store.onChange<unknown>((key, value) => {
    const mapped = map[key];
    if (mapped) cb(mapped, value);
  });
  const unsubEvent = await listen<{ key: string; value: unknown }>(
    PREFS_CHANGED_EVENT,
    (e) => {
      const mapped = map[e.payload.key];
      if (mapped) cb(mapped, e.payload.value);
    },
  );
  return () => {
    unsubLocal();
    unsubEvent();
  };
}
