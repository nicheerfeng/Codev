import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/lib/i18n";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  AUTO_SAVE_DELAY_MAX,
  AUTO_SAVE_DELAY_MIN,
  clampAutoSaveDelay,
  clampEditorWordWrapColumn,
  EDITOR_FONT_SIZES,
  EDITOR_WORD_WRAP_COLUMN_MAX,
  EDITOR_WORD_WRAP_COLUMN_MIN,
  setEditorAutoSave,
  setEditorAutoSaveDelay,
  setEditorFontSize,
  setEditorWordWrap,
  setEditorWordWrapColumn,
} from "@/modules/settings/store";
import { useEffect, useState } from "react";
import { SettingRow } from "../components/SettingRow";

const AUTO_SAVE_STEP = 100;

/** 渲染紧凑的字体、换行和自动保存设置。 */
export function EditorSection() {
  const t = useT();
  const editorFontSize = usePreferencesStore((s) => s.editorFontSize);
  const editorWordWrap = usePreferencesStore((s) => s.editorWordWrap);
  const editorWordWrapColumn = usePreferencesStore(
    (s) => s.editorWordWrapColumn,
  );
  const editorAutoSave = usePreferencesStore((s) => s.editorAutoSave);
  const editorAutoSaveDelay = usePreferencesStore((s) => s.editorAutoSaveDelay);

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[12px] font-semibold tracking-tight">
        {t("Editor")}
      </h2>
      <SettingRow
        title={t("Font size")}
        description={t("Code editor text size.")}
      >
        <Select
          value={String(editorFontSize)}
          onValueChange={(value) => void setEditorFontSize(Number(value))}
        >
          <SelectTrigger size="sm" className="h-7 w-20 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EDITOR_FONT_SIZES.map((size) => (
              <SelectItem
                key={size}
                value={String(size)}
                className="text-[11px]"
              >
                {size}px
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        title={t("Word wrap")}
        description={t("Wrap long lines instead of scrolling horizontally.")}
      >
        <Switch
          checked={editorWordWrap}
          onCheckedChange={(value) => void setEditorWordWrap(value)}
        />
      </SettingRow>
      {editorWordWrap && (
        <WordWrapColumnInput
          value={editorWordWrapColumn}
          onChange={(value) => void setEditorWordWrapColumn(value)}
        />
      )}
      <SettingRow
        title={t("Auto save")}
        description={t(
          "Automatically save files after a delay when changes are detected.",
        )}
      >
        <Switch
          checked={editorAutoSave}
          onCheckedChange={(value) => void setEditorAutoSave(value)}
        />
      </SettingRow>
      {editorAutoSave && (
        <AutoSaveDelayInput
          value={editorAutoSaveDelay}
          onChange={(value) => void setEditorAutoSaveDelay(value)}
        />
      )}
    </section>
  );
}

/** 渲染自动保存延迟输入。 */
function AutoSaveDelayInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(String(value));

  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = clampAutoSaveDelay(parsed);
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <SettingRow
      title={t("Auto save delay")}
      description={t("Delay before unsaved changes are saved automatically.")}
    >
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          min={AUTO_SAVE_DELAY_MIN}
          max={AUTO_SAVE_DELAY_MAX}
          step={AUTO_SAVE_STEP}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="h-7 w-16 px-2 text-right text-[11px] tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span className="text-[10px] text-muted-foreground">ms</span>
      </div>
    </SettingRow>
  );
}

/** 渲染软换行列数输入。 */
function WordWrapColumnInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(String(value));

  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = clampEditorWordWrapColumn(parsed);
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <SettingRow title={t("Wrap column")}>
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          min={EDITOR_WORD_WRAP_COLUMN_MIN}
          max={EDITOR_WORD_WRAP_COLUMN_MAX}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="h-7 w-16 px-2 text-right text-[11px] tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span className="text-[10px] text-muted-foreground">columns</span>
      </div>
    </SettingRow>
  );
}
