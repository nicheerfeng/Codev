import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require=createRequire(import.meta.url);
const {chromium}=require("C:/Users/79988/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");

/** 第二遍从生产 DOM 和原生事件反查编辑资格、图标及提交控件。 */
async function main(){
  const browser=await chromium.launch({channel:"chrome",headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1200,height:950}});
    const errors=[];page.on("pageerror",error=>errors.push(error.message));
    await page.goto("http://localhost:1420/docs/development/codex-agent/qa.html");
    await page.getByRole("button",{name:"工作会话 1 Codev",exact:true}).waitFor();
    await page.evaluate(()=>{window.codexQA.threads[0].turns=[
      {id:"old",status:"completed",items:[{id:"old-user",type:"userMessage",content:[{type:"text",text:"旧轮输入"}]}]},
      {id:"last",status:"interrupted",items:[{id:"first-input",type:"userMessage",content:[{type:"text",text:"保留同轮较早输入"}]},{id:"last-input",type:"userMessage",content:[{type:"text",text:"编辑最后输入"}]}]},
      {id:"system",status:"completed",items:[{id:"compact",type:"contextCompaction"}]},
    ];});
    await page.getByRole("button",{name:"工作会话 1 Codev",exact:true}).click();
    const edit=page.getByRole("button",{name:"编辑最后一条输入",exact:true});
    await page.locator('[data-codex-item="last-input"]').hover();
    await edit.waitFor({state:"attached"});
    assert.equal(await edit.count(),1);
    assert.equal(await edit.innerText(),"");
    assert.equal(await edit.locator("svg").count(),1);
    assert.equal(await edit.locator("svg").getAttribute("width"),"13");
    assert.equal(await page.locator('[data-codex-item="first-input"] button[aria-label="编辑最后一条输入"]').count(),0);
    await edit.click();
    const input=page.getByRole("textbox",{name:"编辑最后一条输入"});
    await input.fill("   ");
    assert.equal(await page.locator('.codex-user-turn').getByRole("button",{name:"发送",exact:true}).isDisabled(),true);
    assert.equal(await page.locator('[data-codex-item="last-input"] .codex-message-actions').count(),0);
    await page.getByRole("button",{name:"取消",exact:true}).click();
    await page.locator('[data-codex-item="last-input"]').hover();await edit.click();
    assert.equal(await input.inputValue(),"编辑最后输入");
    await page.evaluate(()=>window.codexQA.event({method:"turn/started",params:{threadId:"qa-0",turn:{id:"running",items:[],status:"inProgress"}}}));
    await page.waitForFunction(()=>!document.querySelector('button[aria-label="编辑最后一条输入"]'));
    assert.equal(await input.count(),0);
    await page.evaluate(()=>window.codexQA.event({method:"turn/completed",params:{threadId:"qa-0",turn:{id:"running",items:[],status:"interrupted"}}}));
    await edit.waitFor({state:"attached"});assert.equal(await edit.count(),1);
    await page.locator('[data-codex-item="last-input"]').hover();await edit.click();await input.fill("更新后的最后输入");
    await page.locator('.codex-user-turn').getByRole("button",{name:"发送",exact:true}).click();
    await page.waitForFunction(()=>window.codexQA.sent.some(message=>message.method==="turn/start"));
    const sent=await page.evaluate(()=>window.codexQA.sent.find(message=>message.method==="turn/start").params.input);
    assert.equal(sent[0].text,"保留同轮较早输入");assert.equal(sent[1].text,"更新后的最后输入");
    assert.deepEqual(errors,[]);
    console.log("PASS: pencil icon, single latest input, cancelled-turn editing, system-tail handling, blank guard, cancel restore, running-state invalidation, original-input preservation");
  }finally{await browser.close();}
}
await main();
