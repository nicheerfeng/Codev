import { describe, expect, it } from "vitest";
import {
  compareDottedVersions,
  formatReleaseNotes,
  parseDottedVersion,
  updateReleaseStatus,
} from "./releaseChannel";

describe("release channel labels", () => {
  it("extracts dotted versions from probe and tag text", () => {
    expect(parseDottedVersion("0.85.0")).toBe("0.85.0");
    expect(parseDottedVersion("pi 0.85.0")).toBe("0.85.0");
    expect(parseDottedVersion("v0.85.0")).toBe("0.85.0");
    expect(parseDottedVersion("")).toBeNull();
  });

  it("compares dotted versions by numeric segments", () => {
    expect(compareDottedVersions("0.86.0", "0.85.0")).toBeGreaterThan(0);
    expect(compareDottedVersions("0.85.0", "0.85.0")).toBe(0);
    expect(compareDottedVersions("0.84.9", "0.85")).toBeLessThan(0);
  });

  it("describes whether GitHub is newer than the installed build", () => {
    expect(updateReleaseStatus("1.0.0", "1.0.0")).toBe("已是最新版本 1.0.0");
    expect(updateReleaseStatus("1.0.0", "1.1.0")).toBe("有更新：1.0.0 → 1.1.0");
  });

  it("keeps release notes readable without HTML comments", () => {
    expect(
      formatReleaseNotes(
        "<!-- skip -->\n\n把本地文件接到 Pi。\n\n\n## 下载\n- Setup.exe",
      ),
    ).toBe("把本地文件接到 Pi。\n\n## 下载\n- Setup.exe");
  });
});
