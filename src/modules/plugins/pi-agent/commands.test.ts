import { describe, it, expect } from "vitest";
import { localCommand } from "./commands";

describe("Pi local slash dispatch", () => {
  it("passes compact instructions intact and recognizes only complete built-in names", () => {
    expect(localCommand("/compact 保留代码\n保留待办")).toEqual({
      name: "compact",
      argument: "保留代码\n保留待办",
    });
    expect(localCommand("/compact-extra")).toBeNull();
    expect(localCommand("/skill:review")).toBeNull();
    expect(localCommand("讨论 /compact")).toBeNull();
    expect(localCommand("/fork")).toEqual({ name: "fork", argument: "" });
    expect(localCommand("/clone")).toBeNull();
  });
});
