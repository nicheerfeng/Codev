import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// 使用调用者指定的现有 Playwright，不下载包或浏览器。
const { chromium } = createRequire(import.meta.url)(process.argv[2]);
const base = 'http://127.0.0.1:1422/docs/development/pi-agent-plugin/qa.html';
const browser = await chromium.launch({ channel: 'chrome', headless: true });

/** 等待 React 提交和 ResizeObserver 更新。 */
async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** 用不可变快照驱动隔离时间线，保持真实组件的记忆化行为。 */
async function render(page, items, running = true, searchOpen = false) {
  await page.evaluate(state => window.piQA.setTranscript(state), { items, running, searchOpen });
  await settle(page);
}

/** 核验真实停止、编辑、重发链路，底部草稿不可被覆盖。 */
async function checkEditing(page) {
  await page.goto(base);
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  const composer = page.getByPlaceholder('描述任务，或输入 / 命令…');
  await composer.fill('终止编辑核验');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '停止生成', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '编辑最后一条输入', includeHidden: true }).count(), 0);
  await composer.fill('保留底部草稿');
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await page.locator('.pi-user-turn').last().hover();
  await page.getByRole('button', { name: '编辑最后一条输入', exact: true }).click();
  await page.locator('.pi-user-edit-input').fill('修改后重发');
  await page.locator('.pi-user-edit-actions').getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '停止生成', exact: true }).waitFor();
  assert.equal(await composer.inputValue(), '保留底部草稿');
  const commands = await page.evaluate(() => window.piQA.sent.map(entry => entry.command).filter(Boolean));
  assert.ok(commands.some(command => command.type === 'fork'));
  assert.equal(commands.filter(command => command.type === 'prompt').at(-1).message, '修改后重发');
}

/** 核验真实记录、逐行展开、状态保留、搜索及轻量动画。 */
async function checkTranscript(page) {
  await page.goto(`${base}?transcript`);
  await page.waitForFunction(() => !!window.piQA?.setTranscript);
  const items = [
    { id: 'u', kind: 'message', role: 'user', text: '检查页面', thinking: '', streaming: false },
    { id: 't', kind: 'thinking', text: `开头应保留 ${'详细思考 '.repeat(100)}尾部`, streaming: true },
  ];
  await render(page, items);
  assert.notEqual(await page.locator('.pi-process').getAttribute('open'), null);
  assert.equal(await page.locator('.pi-activity').getAttribute('open'), null);
  assert.match(await page.locator('.pi-activity > summary').innerText(), /^思考中 · 开头应保留/);
  assert.match(await page.locator('.pi-activity > summary').innerText(), /…$/);
  items[1].streaming = false;
  items.push({ id: 'tool', kind: 'tool', toolCallId: 'tool', name: 'bash', status: 'running', args: { command: 'python check.py' }, output: '完整工具结果' });
  await render(page, items);
  assert.match(await page.locator('.pi-activity > summary').innerText(), /bash · python check.py/);
  await page.locator('.pi-activity > summary').click();
  assert.equal(await page.locator('.pi-tool-group').count(), 0);
  assert.equal(await page.locator('.pi-record-summary').count(), 2);
  assert.equal(await page.locator('.pi-process-step-body').count(), 0);
  assert.equal(await page.locator('.pi-tool-body').count(), 0);
  await page.locator('.pi-process-step > summary').click();
  await page.locator('.pi-tool > summary').click();
  await page.locator('.pi-tool-body').waitFor();
  assert.match(await page.locator('.pi-tool-body').innerText(), /完整工具结果/);
  await page.locator('.pi-activity > summary').click();
  await page.locator('.pi-activity > summary').click();
  assert.notEqual(await page.locator('.pi-tool').getAttribute('open'), null);
  await page.evaluate(() => { window.qaPreview = document.querySelector('.pi-summary-transition'); });
  items[2].args.command = 'python check_updated.py';
  await render(page, items);
  assert.equal(await page.evaluate(() => window.qaPreview === document.querySelector('.pi-summary-transition')), true);
  items[2].status = 'done';
  await render(page, items);
  assert.equal(await page.evaluate(() => window.qaPreview === document.querySelector('.pi-summary-transition')), false);
  assert.equal(await page.locator('.pi-summary-transition').evaluate(el => getComputedStyle(el).animationName), 'pi-summary-enter');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.pi-summary-transition').evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.locator('.pi-process-step > summary').click();
  await render(page, items, false, true);
  await page.getByPlaceholder('搜索当前线程').fill('详细思考');
  await page.locator('.pi-process-step-body').waitFor();
  assert.equal(await page.locator('[data-pi-text="t"]').isVisible(), true);
}

try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  page.setDefaultTimeout(10000);
  await checkEditing(page);
  console.log('[1/2] PASS: stop, edit, resend, preserve draft');
  await checkTranscript(page);
  console.log('[2/2] PASS: lazy details, previews, search, expansion, animation');
} finally {
  await browser.close();
}
