import { describe, expect, it } from "vitest";
import {
  closeImageLightbox,
  getImageLightbox,
  openImageLightbox,
  subscribeImageLightbox,
} from "./imageLightboxStore";

describe("image lightbox store", () => {
  it("opens, replaces, and closes the current image", () => {
    closeImageLightbox();
    expect(getImageLightbox()).toBeNull();
    let ticks = 0;
    const stop = subscribeImageLightbox(() => {
      ticks += 1;
    });
    openImageLightbox("data:image/png;base64,abc", "附图");
    expect(getImageLightbox()).toEqual({
      src: "data:image/png;base64,abc",
      alt: "附图",
    });
    openImageLightbox("blob:local/1");
    expect(getImageLightbox()?.src).toBe("blob:local/1");
    closeImageLightbox();
    expect(getImageLightbox()).toBeNull();
    openImageLightbox("");
    expect(getImageLightbox()).toBeNull();
    expect(ticks).toBe(3);
    stop();
  });
});
