import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/79988/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

/** 检查资源管理、禁用条件和重连草稿保留，全部调用均为隔离协议。 */
async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://localhost:1420/docs/development/codex-agent/qa.html");
    const resource = page.getByRole("combobox", { name: "登录资源", exact: true });
    await page.waitForFunction(() => !document.querySelector('[aria-label="登录资源"]')?.disabled);
    await page.getByRole("button", { name: "Codex 设置", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("特点：支持类似 cc-switch 的资源切换，无需重启 Codev、无需代理。", { exact: false }).waitFor();
    assert.equal(await dialog.locator("details").first().getAttribute("open"), null);
    await dialog.locator("summary").filter({ hasText: "更多" }).click();
    await dialog.getByText("多视口或仍有任务运行时不可切换资源", { exact: false }).waitFor();
    assert.equal(await dialog.getByRole("button", { name: "应用当前资源", exact: true }).count(), 1);
    await dialog.getByRole("button", { name: "添加资源", exact: true }).click();
    await dialog.getByRole("textbox", { name: "资源别名" }).fill("实验资源 C");
    await dialog.getByRole("textbox", { name: "资源 baseURL" }).fill("https://test.invalid/v1");
    await dialog.getByLabel("资源 API key", { exact: true }).fill("fake-test-secret");
    await dialog.getByRole("button", { name: "保存资源", exact: true }).click();
    await dialog.getByRole("button", { name: "编辑 实验资源 C", exact: true }).waitFor();
    assert(!(await dialog.innerText()).includes("fake-test-secret"));
    await dialog.getByRole("button", { name: "编辑 实验资源 C", exact: true }).click();
    assert.equal(await dialog.getByLabel("资源 API key", { exact: true }).inputValue(), "");
    await dialog.getByRole("button", { name: "取消编辑", exact: true }).click();
    await dialog.getByRole("button", { name: "探测", exact: true }).last().click();
    await dialog.getByText("模型目录可达，共 1 个模型；未执行生成调用。", { exact: true }).waitFor();
    await page.screenshot({ path: "output/codex-resource-settings.png" });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "多视口", exact: true }).click();
    assert(await resource.isDisabled());
    await page.getByRole("button", { name: "退出多视口", exact: true }).click();
    await page.getByRole("button", { name: "工作会话 1 Codev", exact: true }).click();
    const composer = page.getByRole("textbox", { name: "发送给 Codex" });
    await composer.fill("keep this draft");
    await page.evaluate(() => window.codexQA.event({ method: "thread/status/changed", params: { threadId: "hidden-child", status: { type: "active" } } }));
    assert(await resource.isDisabled());
    await page.getByRole("button", { name: "Codex 设置", exact: true }).click();
    await dialog.getByText("还有 1 个任务运行或等待确认", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.evaluate(() => window.codexQA.event({ method: "thread/status/changed", params: { threadId: "hidden-child", status: { type: "idle" } } }));
    await resource.click();
    await page.getByRole("option", { name: "资源 B", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="登录资源"]')?.textContent.includes("资源 B") && !document.querySelector('[aria-label="登录资源"]')?.disabled);
    assert.equal(await composer.inputValue(), "keep this draft");
    assert.equal(await page.evaluate(() => window.codexQA.sent.filter((message) => message.method === "initialize").length), 2);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByRole("button", { name: "停止", exact: true }).waitFor();
    assert(await resource.isDisabled());
    assert(await page.evaluate(() => window.codexQA.sent.some((message) => message.method === "thread/resume")));
    await page.getByRole("button", { name: "停止", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="登录资源"]')?.disabled);
    await page.screenshot({ path: "output/codex-resource-active.png" });
    assert.deepEqual(errors, []);
    console.log("PASS: resource CRUD/masking, settings note, multi-view guard, hidden task guard, reconnect and retained draft");
  } finally { await browser.close(); }
}
await main();
