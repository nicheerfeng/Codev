import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/79988/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

/** 验证命令补全、键盘导航与原生 IPC 分发，避免把 slash 命令当作模型提示词。 */
async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://localhost:1420/docs/development/codex-agent/qa.html");
    await page.getByRole("button", { name: "工作会话 1 Codev", exact: true }).click();
    const input = page.getByRole("textbox", { name: "发送给 Codex" });
    await input.fill("/");
    await page.getByRole("option").filter({ hasText: "全局技能" }).waitFor();
    assert.equal(await page.getByRole("listbox", { name: "Codex 命令" }).getByRole("option").count(), 7);
    await input.press("ArrowDown");
    assert.match(await page.getByRole("option", { selected: true }).innerText(), /fork/);
    await input.press("Escape");
    assert.equal(await page.getByRole("listbox", { name: "Codex 命令" }).count(), 0);
    await input.fill("/mo"); await input.press("Tab");
    assert.equal(await input.inputValue(), "/model");
    await input.press("Enter");
    await page.getByRole("textbox", { name: "搜索模型" }).waitFor();
    await page.keyboard.press("Escape");
    await input.fill("/compact"); await input.press("Enter");
    await page.waitForFunction(() => window.codexQA.sent.some((m) => m.method === "thread/compact/start"));
    assert.equal(await page.evaluate(() => window.codexQA.sent.filter((m) => m.method === "turn/start").length), 0);
    await input.fill("/unsupported"); await input.press("Enter");
    assert.equal(await input.inputValue(), "/unsupported");
    assert.equal(await page.evaluate(() => window.codexQA.sent.filter((m) => m.method === "turn/start").length), 0);
    await input.fill("plain"); await input.press("Shift+Enter");
    assert.equal(await input.inputValue(), "plain\n");
    await input.fill("/");
    await page.screenshot({ path: "output/codex-slash-menu.png" });
    await page.getByRole("option").filter({ hasText: "项目技能 D:/qa/Codev" }).click();
    await page.getByRole("button", { name: "移除技能 shared-skill" }).waitFor();
    await input.fill("使用选中的技能"); await input.press("Enter");
    await page.waitForFunction(() => window.codexQA.sent.some((m) => m.method === "turn/start"));
    const skillInput = await page.evaluate(() => window.codexQA.sent.find((m) => m.method === "turn/start").params.input.find((i) => i.type === "skill"));
    assert.deepEqual(skillInput, { type: "skill", name: "shared-skill", path: "D:/qa/Codev/.agents/skills/shared/SKILL.md" });
    await input.fill("/stop"); await input.press("Enter");
    await page.waitForFunction(() => window.codexQA.sent.some((m) => m.method === "turn/interrupt"));
    await page.getByRole("button", { name: "工作会话 5 Research", exact: true }).click();
    await input.fill("/");
    await page.getByRole("option").filter({ hasText: "项目技能 D:/qa/Research" }).waitFor();
    assert.equal(await page.getByRole("option").filter({ hasText: "项目技能 D:/qa/Codev" }).count(), 0);
    const beforeRefresh = await page.evaluate(() => window.codexQA.sent.filter((m) => m.method === "skills/list").length);
    await page.evaluate(() => window.codexQA.event({ method: "skills/changed", params: {} }));
    await page.waitForFunction((count) => window.codexQA.sent.filter((m) => m.method === "skills/list").length > count, beforeRefresh);
    await input.fill("/new"); await input.press("Enter");
    await page.waitForFunction(() => window.codexQA.sent.some((m) => m.method === "thread/start"));
    assert.deepEqual(errors, []);
    console.log("PASS: slash menu/navigation/completion, model, compact, new, unknown command guard, Shift+Enter, global/project skills, native skill input, project isolation, skills/changed refresh");
  } finally { await browser.close(); }
}
await main();
