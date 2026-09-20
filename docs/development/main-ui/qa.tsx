import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import "/src/styles/globals.css";
const calls: Array<{ command: string; args: any }> = [];
mockWindows("main");
mockIPC(async (command, args: any) => {
  calls.push({ command, args });
  if (command === "fs_search_query") return { hits: [{ path: "D:/qa/报告", rel: "报告", name: "报告", is_dir: true }, { path: "D:/qa/src/报告.md", rel: "src/报告.md", name: "报告.md", is_dir: false }], truncated: false, scanned: args.query === "超限" ? 200001 : 200000, unreadable: 0, scan_incomplete: args.query === "超限", matched: 2 };
  if (command === "fs_read_dir") return args.path.endsWith("nested") ? [{ name: "leaf.md", kind: "file" }] : [{ name: "nested", kind: "dir" }, { name: "child.md", kind: "file" }];
  if (command === "plugin:store|get") return [null,false];
  if (command === "plugin:store|load") return 1;
  return null;
},{shouldMockEvents:true});
const { ExplorerSearch } = await import("/src/modules/explorer/ExplorerSearch");
(window as any).mainQA = { calls };
/** 使用模拟搜索边界和真实生产组件核验目录展开及超限提示。 */
function QA() {
  const [opened,setOpened]=useState("");
  return <aside style={{width:330,height:"100vh",display:"flex",flexDirection:"column"}}><ExplorerSearch rootPath="D:/qa" open onRequestClose={()=>{}} onOpenFile={setOpened} /><span data-opened>{opened}</span></aside>;
}
createRoot(document.getElementById("root")!).render(<QA />);
