import { describe, expect, it } from "vitest";
import {
  collapseSkillMentions,
  expandSkillMentions,
  insertSkillMention,
  insertSkillToken,
  serializeSkillMention,
  skillFilePath,
  skillHighlightSegments,
  skillShortName,
  splitSkillMentions,
  syncSkillBindings,
} from "./skillMention";

describe("skill mentions", () => {
  it("serializes a hidden-path mention and inserts a visible $name token", () => {
    expect(skillShortName("skill:playwright")).toBe("playwright");
    expect(skillFilePath("C:/Users/79988/.agents/skills/playwright")).toBe(
      "C:/Users/79988/.agents/skills/playwright/SKILL.md",
    );
    expect(
      serializeSkillMention(
        "playwright",
        "C:/Users/79988/.agents/skills/playwright",
      ),
    ).toBe("[$playwright](C:/Users/79988/.agents/skills/playwright/SKILL.md)");
    expect(insertSkillToken("/skill:playwright", "playwright")).toBe(
      "$playwright ",
    );
    expect(insertSkillToken("先看这个", "playwright")).toBe(
      "$playwright 先看这个",
    );
  });

  it("keeps path in bindings when inserting a skill into the input line", () => {
    expect(
      insertSkillMention("/skill:playwright", {
        name: "playwright",
        path: "C:/Users/79988/.agents/skills/playwright",
      }),
    ).toEqual({
      text: "$playwright ",
      skills: [
        {
          name: "playwright",
          path: "C:/Users/79988/.agents/skills/playwright/SKILL.md",
        },
      ],
    });
    expect(
      syncSkillBindings("你好", [
        {
          name: "playwright",
          path: "C:/Users/79988/.agents/skills/playwright/SKILL.md",
        },
      ]),
    ).toEqual([]);
    expect(
      collapseSkillMentions(
        "[$playwright](C:/Users/79988/.agents/skills/playwright/SKILL.md) 你看到了什么？",
      ),
    ).toEqual({
      text: "$playwright 你看到了什么？",
      skills: [
        {
          name: "playwright",
          path: "C:/Users/79988/.agents/skills/playwright/SKILL.md",
        },
      ],
    });
    expect(
      skillHighlightSegments("$playwright 你看到了什么？", [
        {
          name: "playwright",
          path: "C:/Users/79988/.agents/skills/playwright/SKILL.md",
        },
      ]),
    ).toEqual([
      { text: "$playwright", skill: true },
      { text: " 你看到了什么？", skill: false },
    ]);
  });

  it("expands $name from bindings first, then catalog paths", () => {
    const catalog = [
      {
        name: "playwright",
        path: "C:/Users/79988/.agents/skills/playwright",
      },
    ];
    expect(expandSkillMentions("$playwright 你看到了什么？", catalog)).toBe(
      "[$playwright](C:/Users/79988/.agents/skills/playwright/SKILL.md) 你看到了什么？",
    );
    expect(
      expandSkillMentions("/skill:playwright 你看到了什么？", catalog),
    ).toBe(
      "[$playwright](C:/Users/79988/.agents/skills/playwright/SKILL.md) 你看到了什么？",
    );
    expect(expandSkillMentions("/compact 保留代码", catalog)).toBe(
      "/compact 保留代码",
    );
    expect(
      expandSkillMentions("$skill-creator 你看到了什么？", [
        {
          name: "skill-creator",
          path: "C:/Users/79988/.codex/skills/.system/skill-creator/SKILL.md",
        },
      ]),
    ).toBe(
      "[$skill-creator](C:/Users/79988/.codex/skills/.system/skill-creator/SKILL.md) 你看到了什么？",
    );
  });

  it("splits serialized mentions for inline display", () => {
    expect(
      splitSkillMentions(
        "[$playwright](C:/Users/79988/.agents/skills/playwright/SKILL.md) 你看到了什么？",
      ),
    ).toEqual([
      {
        kind: "skill",
        name: "playwright",
        path: "C:/Users/79988/.agents/skills/playwright/SKILL.md",
      },
      { kind: "text", text: " 你看到了什么？" },
    ]);
  });
});
