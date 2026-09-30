import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/** 将 PDF.js 的运行时静态资源复制到审核窗口可访问的统一目录。 */
export function pdfAssets(): Plugin {
  const source = path.resolve(
    import.meta.dirname,
    "../node_modules/pdfjs-dist",
  );
  const assets = ["cmaps", "standard_fonts", "wasm", "iccs", "web/images"];
  return {
    name: "codev-pdf-assets",
    configureServer(server) {
      server.middlewares.use("/pdf-assets", (request, response, next) => {
        const relative = decodeURIComponent(
          new URL(request.url ?? "/", "http://localhost").pathname,
        ).replace(/^\/+/, "");
        const target = path.resolve(source, relative);
        if (!assets.some((asset) => relative === asset || relative.startsWith(`${asset}/`))) {
          next();
          return;
        }
        if (!target.startsWith(`${source}${path.sep}`) || !fs.existsSync(target)) {
          next();
          return;
        }
        response.setHeader("Cache-Control", "no-cache");
        fs.createReadStream(target).pipe(response);
      });
    },
    generateBundle() {
      const emitDirectory = (directory: string, prefix: string) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          const target = `${prefix}/${entry.name}`;
          if (entry.isDirectory()) emitDirectory(file, target);
          else this.emitFile({ type: "asset", fileName: target, source: fs.readFileSync(file) });
        }
      };
      for (const asset of assets) {
        emitDirectory(path.resolve(source, asset), `pdf-assets/${asset}`);
      }
    },
  };
}
