import { describe, expect, it } from "vitest";
import { formatJsonText } from "./JsonFormatterPane";

describe("formatJsonText", () => {
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
