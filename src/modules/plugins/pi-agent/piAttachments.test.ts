import { describe, expect, it } from "vitest";
import {
  addPathAttachments,
  draftHasPayload,
  isImagePath,
  splitUserAttachmentText,
  withAttachmentPrompt,
} from "./piAttachments";

describe("pi attachments", () => {
  it("treats common raster extensions as images", () => {
    expect(isImagePath("D:/a/photo.PNG")).toBe(true);
    expect(isImagePath("note.md")).toBe(false);
    expect(isImagePath("rows.jsonl")).toBe(false);
  });

  it("dedupes path chips by Windows-insensitive path", () => {
    expect(
      addPathAttachments(
        [{ kind: "file", path: "D:/Work/a.py", name: "a.py" }],
        [
          { path: "d:/work/a.py", kind: "file" },
          { path: "D:/Work/b.md", kind: "file" },
          { path: "D:/Work/src", kind: "dir" },
        ],
      ),
    ).toEqual([
      { kind: "file", path: "D:/Work/a.py", name: "a.py" },
      { kind: "file", path: "D:/Work/b.md", name: "b.md" },
      { kind: "dir", path: "D:/Work/src", name: "src" },
    ]);
  });

  it("appends short association lines when sending files or folders", () => {
    expect(
      withAttachmentPrompt("看看这个", [
        { kind: "file", path: "D:/a.py", name: "a.py" },
        { kind: "dir", path: "D:/src", name: "src" },
      ]),
    ).toBe("看看这个\n\n- 关联文件 D:/a.py\n- 关联目录 D:/src");
    expect(
      splitUserAttachmentText(
        "你看到了什么？\n\n- 关联文件 D:/医药交易项目/note.html",
      ),
    ).toEqual({
      body: "你看到了什么？",
      attachments: [
        {
          kind: "file",
          path: "D:/医药交易项目/note.html",
          name: "note.html",
        },
      ],
    });
    expect(draftHasPayload({ text: "", images: [], files: [] })).toBe(false);
    expect(
      draftHasPayload({
        text: "",
        images: [],
        files: [{ kind: "file", path: "D:/a.py", name: "a.py" }],
      }),
    ).toBe(true);
  });
});
