import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.argv[2]);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
/** 使用真实 pointer 捕获拖拽，将侧栏会话放入指定视口。 */
async function dragSession(page, key, index) {
  const source = page.locator(`[data-pi-thread-key="${key}"]`);
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  const to = await page.locator(`[data-pi-viewport-index="${index}"]`).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(70, to.height / 2), { steps: 15 });
  await page.mouse.up();
  await page.waitForFunction(({ key, index }) => document.querySelector(`[data-pi-viewport-index="${index}"]`)?.getAttribute('data-pi-viewport-key') === key, { key, index });
}
try {
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => { console.error(error.message); });
  await page.goto('http://127.0.0.1:1422/docs/development/pi-agent-plugin/qa.html');
  await page.getByRole('button', { name: '项目', exact: true }).click();
  await page.getByRole('button', { name: 'Codev', exact: true }).click();
  const key0 = 'D:/qa/sessions/0.jsonl', key1 = 'D:/qa/sessions/1.jsonl';
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.qaHistoryReads = [];
    /** 记录历史读取，验证重复选择复用已经加载的会话。 */
    window.__TAURI_INTERNALS__.invoke = (command, args, ...rest) => {
      if (command === 'pi_agent_read_session') window.qaHistoryReads.push(args.path);
      return invoke(command, args, ...rest);
    };
  });
  await page.locator(`[data-pi-thread-key="${key0}"] > button`).click();
  await page.getByTestId('pi-thread-title').filter({ hasText: '研究线程 1 (Codev)' }).waitFor();
  await page.getByText('历史回复', { exact: true }).waitFor();
  await page.evaluate(() => { window.qaSinglePane = document.querySelector('[data-pi-viewport-key]'); });
  await page.locator(`[data-pi-thread-key="${key0}"] > button`).click();
  await page.locator(`[data-pi-thread-key="${key1}"] > button`).click();
  await page.getByTestId('pi-thread-title').filter({ hasText: '研究线程 2 (Codev)' }).waitFor();
  await page.getByText('历史回复', { exact: true }).waitFor();
  await page.locator(`[data-pi-thread-key="${key0}"] > button`).click();
  assert.deepEqual(await page.evaluate(() => window.qaHistoryReads), [key0, key1]);
  assert.equal(await page.evaluate(() => window.qaSinglePane === document.querySelector('[data-pi-viewport-key]')), true);
  await page.getByRole('button', { name: '多视口', exact: true }).click();
  await dragSession(page, key1, 1);
  assert.equal(await page.evaluate(() => window.piQA.runtimes.size), 0);
  const first = page.locator(`[data-pi-viewport-key="${key0}"]`);
  const second = page.locator(`[data-pi-viewport-key="${key1}"]`);
  await first.getByPlaceholder('描述任务，或输入 / 命令…').fill('任务 A');
  await second.getByPlaceholder('描述任务，或输入 / 命令…').fill('任务 B');
  await first.getByRole('button', { name: '发送', exact: true }).click();
  await first.getByRole('button', { name: '停止生成', exact: true }).waitFor();
  await second.getByRole('button', { name: '发送', exact: true }).click();
  await second.getByRole('button', { name: '停止生成', exact: true }).waitFor();
  const prompts = await page.evaluate(() => window.piQA.sent.filter(x => x.command?.type === 'prompt').map(x => ({ text: x.command.message, path: window.piQA.runtimes.get(x.sessionId).path })));
  assert.deepEqual(prompts, [{ text: '任务 A', path: key0 }, { text: '任务 B', path: key1 }]);
  await first.getByRole('button', { name: '停止生成', exact: true }).click();
  await first.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await second.getByRole('button', { name: '停止生成', exact: true }).count(), 1);
  await first.getByTitle('双击重命名会话').dblclick();
  const renameInput = first.getByRole('textbox', { name: '重命名 Pi 视口' });
  await renameInput.fill('并行任务 A');
  await renameInput.press('Enter');
  await first.getByTitle('双击重命名会话').filter({ hasText: '并行任务 A (Codev)' }).waitFor();
  await page.locator(`[data-pi-thread-key="${key0}"]`).filter({ hasText: '并行任务 A' }).waitFor();
  await first.getByTitle('双击重命名会话').dblclick();
  await renameInput.fill('取消改名');
  await renameInput.press('Escape');
  assert.equal((await first.getByTitle('双击重命名会话').innerText()).trim(), '并行任务 A (Codev)');
  assert.equal(await second.getByRole('button', { name: '停止生成', exact: true }).count(), 1);
  await first.getByPlaceholder('描述任务，或输入 / 命令…').fill('保留 A 草稿');
  await second.getByPlaceholder('描述任务，或输入 / 命令…').fill('保留 B 草稿');
  const box = await second.locator('[data-pi-composer-drop]').boundingBox();
  await page.evaluate(async ({ x, y }) => {
    const { createPiComposerPathDropTarget } = await import('/src/modules/plugins/pi-agent/piComposerDrop.ts');
    const { usePiComposerDropStore } = await import(performance.getEntriesByType('resource').map(x => x.name).find(x => x.includes('/piComposerDropStore.ts')));
    const target = createPiComposerPathDropTarget({ active: () => true, onDrop: (items, key) => usePiComposerDropStore.getState().drop(items, key) });
    target.dropPath('D:/qa/attachment.txt', x, y);
  }, { x: box.x + 30, y: box.y + 30 });
  await first.getByPlaceholder('描述任务，或输入 / 命令…').focus();
  await second.getByText('attachment.txt', { exact: true }).waitFor();
  assert.equal(await first.getByText('attachment.txt', { exact: true }).count(), 0);
  await dragSession(page, key0, 1);
  assert.equal(await page.locator(`[data-pi-viewport-index="0"]`).getAttribute('data-pi-viewport-key'), key1);
  assert.equal(await first.getByPlaceholder('描述任务，或输入 / 命令…').inputValue(), '保留 A 草稿');
  assert.equal(await second.getByPlaceholder('描述任务，或输入 / 命令…').inputValue(), '保留 B 草稿');
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: '增加 Pi 视口', exact: true }).click();
  await page.getByRole('button', { name: '增加 Pi 视口', exact: true }).click();
  assert.equal(await page.locator('[data-pi-viewport-index]').count(), 6);
  await page.getByText('最多支持 6 个 Pi 会话视口，可替换现有视口中的会话。').waitFor();
  await dragSession(page, 'D:/qa/sessions/2.jsonl', 2);
  await dragSession(page, 'D:/qa/sessions/3.jsonl', 3);
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page.getByRole('button', { name: 'Research', exact: true }).click();
  await dragSession(page, 'D:/qa/sessions/5.jsonl', 4);
  await dragSession(page, 'D:/qa/sessions/6.jsonl', 5);
  assert.equal(await page.locator('[data-pi-viewport-index] [data-testid="pi-composer"]').count(), 6);
  await page.screenshot({ path: `${process.env.TEMP}/codev-pi-multiview.png` });
  await page.setViewportSize({ width: 1000, height: 750 });
  for (const pane of await page.locator('[data-pi-viewport-index]').all()) {
    const bounds = await pane.boundingBox();
    const input = await pane.getByPlaceholder('描述任务，或输入 / 命令…').boundingBox();
    assert.ok(input.width > 100 && input.y >= bounds.y && input.y + input.height <= bounds.y + bounds.height, '窄窗口输入框应保持可用');
  }
  await page.screenshot({ path: `${process.env.TEMP}/codev-pi-multiview-narrow.png` });
  await page.getByRole('button', { name: '关闭视口 1', exact: true }).click();
  assert.equal(await page.locator('[data-pi-viewport-index]').count(), 5);
  assert.deepEqual(await page.evaluate(() => window.piQA.closed), []);
  await page.getByRole('button', { name: '退出多视口', exact: true }).click();
  assert.equal(await page.locator('[data-testid="pi-composer"]').count(), 1);
  console.log('PASS: pointer drag, read-only hydration, independent send/stop/drafts/attachments, swap, six-view limit, close without stopping');
} finally {
  await browser.close();
}
