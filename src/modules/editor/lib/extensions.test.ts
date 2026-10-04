import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  buildSharedExtensions,
  getEditorSearchActiveRange,
  getEditorSearchStatus,
  setEditorSearchSession,
  wordWrapExtension,
} from "./extensions";

describe("wordWrapExtension", () => {
  it("enables native line wrapping at the configured width", () => {
    const state = EditorState.create({
      extensions: [wordWrapExtension(80)],
    });

    expect(state.facet(EditorView.contentAttributes)).toEqual(
      expect.arrayContaining([
        { class: "cm-lineWrapping" },
        { style: "--codev-editor-wrap-column: 80ch" },
      ]),
    );
  });

  it("adds no content attributes when disabled", () => {
    const state = EditorState.create({
      extensions: [wordWrapExtension(null)],
    });

    expect(state.facet(EditorView.contentAttributes)).toEqual([]);
  });

  it("wraps to the editor viewport without a fixed column", () => {
    const state = EditorState.create({
      extensions: [wordWrapExtension("viewport")],
    });

    expect(state.facet(EditorView.contentAttributes)).toEqual([
      { class: "cm-lineWrapping" },
    ]);
  });

  it("reuses the wrap theme across column changes", () => {
    const first = wordWrapExtension(80) as readonly Extension[];
    const second = wordWrapExtension(120) as readonly Extension[];

    expect(first[1]).toBe(second[1]);
  });
});

describe("editor search session", () => {
  it("counts every literal match without changing the editor selection", () => {
    const state = EditorState.create({
      doc: Array.from({ length: 100 }, () => "needle").join(" "),
      selection: { anchor: 2 },
      extensions: buildSharedExtensions(),
    });
    const next = state.update({
      effects: setEditorSearchSession.of({
        query: "needle",
        caseSensitive: false,
        activeIndex: 0,
      }),
    }).state;

    expect(getEditorSearchStatus(next)).toEqual({
      count: 100,
      index: 1,
      truncated: false,
    });
    expect(next.selection.main.from).toBe(2);
    expect(getEditorSearchActiveRange(next)).toEqual({ from: 0, to: 6 });
  });

  it("moves the active range independently from the text selection", () => {
    const state = EditorState.create({
      doc: "a needle b needle",
      selection: { anchor: 1 },
      extensions: buildSharedExtensions(),
    });
    const next = state.update({
      effects: setEditorSearchSession.of({
        query: "needle",
        caseSensitive: false,
        activeIndex: 1,
      }),
    }).state;

    expect(getEditorSearchStatus(next).index).toBe(2);
    expect(next.selection.main.from).toBe(1);
    expect(getEditorSearchActiveRange(next)).toEqual({ from: 11, to: 17 });
  });

  it("recomputes matches after editing without moving the text selection", () => {
    const state = EditorState.create({
      doc: "a needle b needle",
      selection: { anchor: 1 },
      extensions: buildSharedExtensions(),
    });
    const searched = state.update({
      effects: setEditorSearchSession.of({
        query: "needle",
        caseSensitive: false,
        activeIndex: 1,
      }),
    }).state;
    const edited = searched.update({
      changes: { from: searched.doc.length, insert: " c needle" },
    }).state;

    expect(getEditorSearchStatus(edited)).toEqual({
      count: 3,
      index: 2,
      truncated: false,
    });
    expect(edited.selection.main.from).toBe(1);
    expect(getEditorSearchActiveRange(edited)).toEqual({ from: 11, to: 17 });
  });
});
