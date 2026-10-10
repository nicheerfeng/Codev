import { describe, expect, it } from "vitest";
import { moveItem, moveNote, normalizeNotePad } from "./model";

describe("notepad model", () => {
  it("seeds a locked tmp project and drops broken rows", () => {
    const pad = normalizeNotePad({
      inbox: [{ id: "a", text: "one", done: true }, { text: "bad" }, null],
      projects: [
        { id: "p", name: "Codev", items: [{ id: "b", text: "two" }] },
        { name: "missing-id" },
      ],
    });
    expect(pad.projects[0]).toMatchObject({
      id: "tmp",
      name: "tmp",
      locked: true,
      items: [{ id: "a", text: "one", done: true }],
    });
    expect(pad.projects[1]).toMatchObject({
      id: "p",
      name: "Codev",
      items: [{ id: "b", text: "two", done: false }],
    });
  });
  it("reorders without mutating the original list", () => {
    const list = ["a", "b", "c"];
    expect(moveItem(list, 0, 2)).toEqual(["b", "c", "a"]);
    expect(list).toEqual(["a", "b", "c"]);
  });
  it("moves a note between tmp and a project", () => {
    const pad = normalizeNotePad({
      inbox: [{ id: "a", text: "one" }],
      projects: [{ id: "p", name: "Codev", items: [{ id: "b", text: "two" }] }],
    });
    const moved = moveNote(pad, "tmp", 0, "p", 1);
    expect(moved.projects[0]?.items).toEqual([]);
    expect(moved.projects[1]?.items.map((item) => item.id)).toEqual(["b", "a"]);
  });
  it("drops onto an empty project and back to tmp", () => {
    const pad = normalizeNotePad({
      inbox: [{ id: "a", text: "one" }],
      projects: [{ id: "p", name: "Codev", items: [] }],
    });
    const into = moveNote(pad, "tmp", 0, "p", 0);
    expect(into.projects[0]?.items).toEqual([]);
    expect(into.projects[1]?.items.map((item) => item.id)).toEqual(["a"]);
    const back = moveNote(into, "p", 0, "tmp", 0);
    expect(back.projects[0]?.items.map((item) => item.id)).toEqual(["a"]);
    expect(back.projects[1]?.items).toEqual([]);
  });
});
