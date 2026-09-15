import { describe, expect, it } from "vitest";
import {
  joinFsPath,
  parentDirectory,
  resolveHtmlAssetPath,
  rewriteHtmlLocalAssets,
} from "./localAssetUrl";

describe("html local asset urls", () => {
  const page = "D:/proj/page.html";

  it("resolves relative images against the html directory", () => {
    expect(resolveHtmlAssetPath(page, "./fig/a.png")).toBe("D:/proj/fig/a.png");
    expect(resolveHtmlAssetPath(page, "fig/a.png")).toBe("D:/proj/fig/a.png");
    expect(resolveHtmlAssetPath(page, "../x.png")).toBe("D:/x.png");
  });

  it("keeps windows drive-root and file urls", () => {
    expect(resolveHtmlAssetPath(page, "/fig/a.png")).toBe("D:/fig/a.png");
    expect(resolveHtmlAssetPath(page, "C:\\abs\\a.png")).toBe("C:/abs/a.png");
    expect(resolveHtmlAssetPath(page, "file:///D:/proj/fig/a.png")).toBe(
      "D:/proj/fig/a.png",
    );
  });

  it("leaves remote urls untouched", () => {
    expect(resolveHtmlAssetPath(page, "https://cdn.example/a.png")).toBeNull();
    expect(resolveHtmlAssetPath(page, "data:image/png;base64,xx")).toBeNull();
  });

  it("joins unix directories without dropping the root", () => {
    expect(parentDirectory("/home/u/proj/page.html")).toBe("/home/u/proj");
    expect(joinFsPath("/home/u/proj", "../img/a.png")).toBe(
      "/home/u/img/a.png",
    );
  });

  it("rewrites local images with a whole-path asset url", () => {
    const toSrc = (abs: string) =>
      `http://asset.localhost/${encodeURIComponent(abs)}`;
    const html = rewriteHtmlLocalAssets(
      `<img src="./fig/a.png"><link href="style.css" rel="stylesheet">`,
      "D:/proj/page.html",
      toSrc,
    );
    expect(html).toContain(encodeURIComponent("D:\\proj\\fig\\a.png"));
    expect(html).toContain(encodeURIComponent("D:\\proj\\style.css"));
    expect(html).not.toContain("./fig/a.png");
    expect(html).toContain('<base href="about:srcdoc">');
  });

  it("does not rewrite navigation anchors", () => {
    const toSrc = (abs: string) =>
      `http://asset.localhost/${encodeURIComponent(abs)}`;
    const html = rewriteHtmlLocalAssets(
      `<a href="./" class="brand">title</a><a href="">empty</a>`,
      "D:/proj/page.html",
      toSrc,
    );
    expect(html).toContain('href="./"');
    expect(html).toContain('href=""');
    expect(html).not.toContain(encodeURIComponent("D:\\proj"));
  });
});
