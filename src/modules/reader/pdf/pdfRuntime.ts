import type { PDFDocumentLoadingTask } from "pdfjs-dist";
import type { PDFViewer } from "pdfjs-dist/types/web/pdf_viewer";
import type { createPdfSearchSession } from "./pdfSearch";

export type PdfRuntime = {
  goToPage: (page: number) => void;
  zoom: (steps: number) => void;
  fit: () => void;
  rotate: () => void;
  download: () => Promise<void>;
  dispose: () => void;
};

type Options = {
  container: HTMLDivElement;
  pages: HTMLDivElement;
  source: () => Promise<string>;
  filename: string;
  search: ReturnType<typeof createPdfSearchSession>;
  onReady: (count: number) => void;
  onPage: (page: number) => void;
  onError: (message: string) => void;
};

/** 解析在 worker 内执行；同一文档的检索不改变 URL，也不重新加载文件。 */
export function mountPdf(options: Options): PdfRuntime {
  let disposed = false;
  const lifetime = new AbortController();
  let loadingTask: PDFDocumentLoadingTask | undefined;
  let viewer: PDFViewer | undefined;
  let detach: (() => void) | undefined;
  let resize: ResizeObserver | undefined;
  let resizeFrame = 0;
  const fail = (error: unknown) => {
    if (!disposed)
      options.onError(error instanceof Error ? error.message : String(error));
  };
  const start = async () => {
    // viewer 组件使用核心模块注册的 pdfjsLib，必须按序导入。
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const [{ PDFViewer, PDFLinkService, PDFFindController, EventBus }, worker] =
      await Promise.all([
        import("pdfjs-dist/legacy/web/pdf_viewer.mjs"),
        import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
        import("pdfjs-dist/web/pdf_viewer.css"),
      ]);
    if (disposed) return;
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const bus = new EventBus();
    const links = new PDFLinkService({ eventBus: bus, externalLinkTarget: 2 });
    const find = new PDFFindController({ eventBus: bus, linkService: links });
    const viewerOptions = {
      abortSignal: lifetime.signal,
      container: options.container,
      viewer: options.pages,
      eventBus: bus,
      linkService: links,
      findController: find,
      textLayerMode: 1,
      annotationMode: 1,
      imageResourcesPath: "/pdf-assets/web/images/",
      maxCanvasPixels: 8_388_608,
    };
    const instance = new PDFViewer(viewerOptions);
    viewer = instance;
    links.setViewer(instance);
    const onPage = ({ pageNumber }: { pageNumber: number }) => {
      if (!disposed) options.onPage(pageNumber);
    };
    const onRendered = ({ error }: { error?: unknown }) => {
      if (error) fail(error);
    };
    const onInit = () => {
      if (disposed) return;
      instance.currentScaleValue = "page-width";
      options.search.connect(bus, find);
      options.onReady(instance.pagesCount);
    };
    bus.on("pagesinit", onInit);
    bus.on("pagechanging", onPage);
    bus.on("pagerendered", onRendered);
    detach = () => {
      bus.off("pagesinit", onInit);
      bus.off("pagechanging", onPage);
      bus.off("pagerendered", onRendered);
      links.setDocument(null);
    };
    resize = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (disposed || !instance.pagesCount || !options.container.clientWidth)
          return;
        if (instance.currentScaleValue === "page-width")
          instance.currentScaleValue = "page-width";
        instance.update();
      });
    });
    resize.observe(options.container);
    const url = await options.source();
    if (disposed) return;
    loadingTask = pdfjs.getDocument({
      url,
      cMapUrl: "/pdf-assets/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdf-assets/standard_fonts/",
      wasmUrl: "/pdf-assets/wasm/",
      iccUrl: "/pdf-assets/iccs/",
      disableAutoFetch: true,
      disableStream: true,
    });
    loadingTask.onPassword = (
      _updatePassword: (password: string) => void,
      reason: number,
    ) => {
      fail(
        new Error(
          reason === 2
            ? "PDF 密码错误，请使用外部阅读器打开"
            : "此 PDF 需要密码，请使用外部阅读器打开",
        ),
      );
      void loadingTask?.destroy().catch(fail);
    };
    const document = await loadingTask.promise;
    if (disposed) return;
    links.setDocument(document);
    instance.setDocument(document);
  };
  void start().catch((error) => {
    if (!disposed) options.search.disconnect();
    fail(error);
  });
  return {
    goToPage(page) {
      if (viewer?.pagesCount && Number.isInteger(page)) {
        viewer.currentPageNumber = Math.min(
          viewer.pagesCount,
          Math.max(1, page),
        );
      }
    },
    zoom(steps) {
      viewer?.updateScale({ steps });
    },
    fit() {
      if (viewer?.pagesCount) viewer.currentScaleValue = "page-width";
    },
    rotate() {
      if (viewer?.pagesCount)
        viewer.pagesRotation = (viewer.pagesRotation + 90) % 360;
    },
    async download() {
      const pdf = viewer?.pdfDocument;
      if (!pdf) return;
      const bytes = await pdf.getData();
      if (disposed) return;
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = options.filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(resizeFrame);
      resize?.disconnect();
      options.search.disconnect();
      detach?.();
      // PDF.js 运行时使用 null 清理文档，但上游类型声明未包含 null。
      // @ts-expect-error PDFViewer.setDocument(null) is the upstream teardown API.
      viewer?.setDocument(null);
      lifetime.abort();
      void loadingTask?.destroy().catch(() => undefined);
    },
  };
}
