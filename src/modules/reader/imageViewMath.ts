/** 图片视口：适合窗口为 1，滚轮以指针为中心缩放，拖动平移。 */

export const IMAGE_MIN_SCALE = 0.25;
export const IMAGE_MAX_SCALE = 4;
export const IMAGE_SCALE_STEP = 0.12;

export type ImagePan = { x: number; y: number };
export type ImageView = { scale: number; pan: ImagePan };

/** 把缩放限制在适合窗口的 25%～400%。 */
export function clampImageScale(value: number): number {
  return Math.min(IMAGE_MAX_SCALE, Math.max(IMAGE_MIN_SCALE, value));
}

/** 滚轮步进：向上放大，向下缩小。 */
export function nextImageScale(scale: number, deltaY: number): number {
  const next = scale + (deltaY < 0 ? IMAGE_SCALE_STEP : -IMAGE_SCALE_STEP);
  return clampImageScale(Math.round(next * 100) / 100);
}

/**
 * 以视口中心坐标系里的指针点为锚，缩放后该点仍停在指针下。
 * pan 是相对视口中心的平移像素。
 */
export function zoomImageAroundPoint(
  scale: number,
  pan: ImagePan,
  nextScale: number,
  point: ImagePan,
): ImageView {
  if (nextScale === scale) return { scale, pan };
  const ratio = nextScale / scale;
  return {
    scale: nextScale,
    pan: {
      x: point.x - (point.x - pan.x) * ratio,
      y: point.y - (point.y - pan.y) * ratio,
    },
  };
}
