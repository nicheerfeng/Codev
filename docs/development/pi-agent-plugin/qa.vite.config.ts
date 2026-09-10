import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwind from "@tailwindcss/vite";
import path from "node:path";

// 使用产品相同的 React 编译器，隔离核验入口不扫描其他参考项目。
export default defineConfig({
  root: path.resolve(import.meta.dirname, "../../.."),
  plugins: [babel({ presets: [reactCompilerPreset({ target: "19" })] }), react(), tailwind()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "../../../src") } },
  optimizeDeps: { entries: ["docs/development/pi-agent-plugin/qa.html"] },
  server: { host: "127.0.0.1", port: 1422, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/artifacts/**", "**/docs/ref-piagent/**"] } },
});
