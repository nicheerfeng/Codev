# Pi Agent UI 参考与许可

Codev 的 Pi UI 按自身 React/Tauri 边界改写，并参考以下项目的组件结构与交互：

- Mcode（https://github.com/huangbh2020/mcode）：LeftBar、SidebarShared、ComposerToolbar、ChatPane；项目/组/线程/归档、输入卡片及模型菜单。
- Zeno（https://github.com/aletheics/zeno）：timeline.ts、SessionTimelineContent；逐 turn 过程聚合和自动跟随/用户翻阅分离。

未包含这两个项目的 Electron、Claude SDK、IDE 或后端运行时。

MIT License

Copyright (c) 2026 Mcode contributors
Copyright (c) 2026 aletheics

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
