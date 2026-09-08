import { describe, expect, it } from "vitest";
import { formatJsonText } from "./JsonFormatterPane";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "JsonFormatterPane.tsx"), "utf8");

describe("formatJsonText", () => {
  it("fills the complete isolated plugin viewport", () => {
    expect(source).toMatch(
      /className="flex h-full min-h-0 min-w-0 w-full max-w-full flex-1 flex-col/,
    );
  });

  it("uses the native partial-text selection path", () => {
    expect(source).toMatch(/drawSelection: false/);
  });

  it("expands a JSON long line", () => {
    expect(formatJsonText('{"name":"Codev","enabled":true}')).toBe(
      '{\n  "name": "Codev",\n  "enabled": true\n}',
    );
  });

  it("formats each non-empty JSONL record independently", () => {
    expect(formatJsonText('{"id":1}\n\n{"id":2}')).toBe(
      '{\n  "id": 1\n}\n\n{\n  "id": 2\n}',
    );
  });

  it("reports the invalid JSONL record line", () => {
    expect(() => formatJsonText('{"id":1}\ninvalid')).toThrow(
      "第 2 行不是有效 JSON",
    );
  });
});
