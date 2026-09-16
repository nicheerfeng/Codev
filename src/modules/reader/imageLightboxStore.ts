/** 全局图片灯箱：任意缩略图点开同一份全屏阅读层。 */

export type ImageLightboxState = {
  src: string;
  alt: string;
};

type Listener = () => void;

let state: ImageLightboxState | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 打开灯箱；空 src 忽略。 */
export function openImageLightbox(src: string, alt = ""): void {
  if (!src) return;
  state = { src, alt };
  emit();
}

/** 关闭灯箱。 */
export function closeImageLightbox(): void {
  if (!state) return;
  state = null;
  emit();
}

/** 当前灯箱内容；关闭时为 null。 */
export function getImageLightbox(): ImageLightboxState | null {
  return state;
}

/** 订阅灯箱开关，供 React 订阅。 */
export function subscribeImageLightbox(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
