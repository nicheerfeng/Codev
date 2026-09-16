import { describe, expect, it } from "vitest";
import { comparePiVersions, parsePiVersion } from "./PiVersionPanel";

describe("pi version labels", () => {
  it("extracts dotted versions from probe and tag text", () => {
    expect(parsePiVersion("0.85.0")).toBe("0.85.0");
    expect(parsePiVersion("pi 0.85.0")).toBe("0.85.0");
    expect(parsePiVersion("v0.85.0")).toBe("0.85.0");
    expect(parsePiVersion("")).toBeNull();
  });

  it("compares dotted versions by numeric segments", () => {
    expect(comparePiVersions("0.86.0", "0.85.0")).toBeGreaterThan(0);
    expect(comparePiVersions("0.85.0", "0.85.0")).toBe(0);
    expect(comparePiVersions("0.84.9", "0.85")).toBeLessThan(0);
  });
});
