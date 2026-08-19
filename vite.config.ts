import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;
const rootDir = import.meta.dirname;

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    babel({
      presets: [reactCompilerPreset({ target: "19" })],
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
    },
  },
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome120" : "es2022",
    chunkSizeWarningLimit: 1500,
    rolldownOptions: {
      input: {
        main: path.resolve(rootDir, "index.html"),
        settings: path.resolve(rootDir, "settings.html"),
      },
      // Oxc drops `debugger` by default. These calls return undefined, so
      // marking them pure lets DCE strip them from production builds.
      treeshake: {
        manualPureFunctions: [
          "console.debug",
          "console.info",
          "console.trace",
        ],
      },
      output: {
        manualChunks(id: string) {
          // Vite's __vitePreload helper is a virtual module. Left to Rollup it
          // gets hoisted into whichever chunk it happens to land in (observed:
          // the 480kB streamdown chunk), and since every lazy importer pulls the
          // helper, that heavy chunk gets dragged into the eager startup graph.
          // Pin it to the always-eager react chunk so it costs nothing extra.
          if (id.includes("vite/preload-helper") || id.includes("/vite/dist/"))
            return "react";

          if (!id.includes("node_modules")) return null;

          // Ubiquitous styling utils used by `cn()` on nearly every eager
          // component. Left unassigned, Rollup absorbs them into whichever
          // feature chunk claims them first (observed: streamdown), dragging
          // that heavy chunk into the eager graph. Pin them to react (eager).
          if (
            id.includes("/clsx/") ||
            id.includes("/tailwind-merge/") ||
            id.includes("/class-variance-authority/")
          )
            return "react";

          if (id.includes("/xterm/") || id.includes("@xterm/")) return "xterm";
          // Lang packs and legacy modes are dynamically imported by
          // languageResolver; give each its own named chunk so they load on
          // demand instead of being glued into the codemirror core chunk.
          // (bundle audit, issue #551)
          {
            const m = id.match(/@codemirror\/lang-([\w-]+)/);
            if (m) return `cm-lang-${m[1]}`;
          }
          {
            const m = id.match(/@codemirror\/legacy-modes\/mode\/([\w-]+)/);
            if (m) return `cm-legacy-${m[1]}`;
          }
          if (id.includes("@replit/codemirror-lang-svelte"))
            return "cm-lang-svelte";
          if (
            id.includes("@codemirror/") ||
            id.includes("@uiw/codemirror") ||
            id.includes("@replit/codemirror")
          )
            return "codemirror";
          if (id.includes("/streamdown/") || id.includes("@streamdown/"))
            return "streamdown";
          if (
            id.includes("/react-dom/") ||
            id.includes("/react/") ||
            id.includes("/scheduler/")
          )
            return "react";
          if (id.includes("@radix-ui/") || id.includes("/radix-ui/"))
            return "radix";

          return null;
        },
      },
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
