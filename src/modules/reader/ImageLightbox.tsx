import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ImageViewport } from "./ImageViewport";
import {
  closeImageLightbox,
  getImageLightbox,
  subscribeImageLightbox,
} from "./imageLightboxStore";

function useImageLightboxState() {
  return useSyncExternalStore(
    subscribeImageLightbox,
    getImageLightbox,
    getImageLightbox,
  );
}

/** 全屏图片阅读：与主界面共用滚轮定点缩放和拖动平移。 */
export function ImageLightbox() {
  const item = useImageLightboxState();

  useEffect(() => {
    if (!item) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeImageLightbox();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item]);

  if (!item) return null;

  const overlay = (
    <div
      className="fixed inset-0 z-[2147483647] bg-black/80"
      role="dialog"
      aria-modal="true"
      aria-label={item.alt || "图片预览"}
    >
      <button
        type="button"
        className="absolute top-3 right-3 z-10 inline-flex size-8 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60"
        aria-label="关闭图片预览"
        onClick={closeImageLightbox}
      >
        <HugeiconsIcon icon={Cancel01Icon} size={16} />
      </button>
      <ImageViewport src={item.src} alt={item.alt} onBackgroundClick={closeImageLightbox} />
    </div>
  );
  return createPortal(overlay, document.body);
}
