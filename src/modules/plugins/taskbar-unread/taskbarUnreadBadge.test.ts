import { describe, expect, it } from "vitest";
import { unreadBadgeLabel } from "./taskbarUnreadBadge";

describe("taskbar unread badge", () => {
  it("hides empty counts and caps at 9+", () => {
    expect(unreadBadgeLabel(0)).toBe("");
    expect(unreadBadgeLabel(1)).toBe("1");
    expect(unreadBadgeLabel(9)).toBe("9");
    expect(unreadBadgeLabel(10)).toBe("9+");
  });
});
