import { cn } from "@/lib/utils";
import type { ComponentProps, MouseEvent } from "react";
import { openImageLightbox } from "./imageLightboxStore";

type Props = ComponentProps<"img"> & { node?: unknown };

/** 可点开全局灯箱的图片。Streamdown 传入的 node 不落到 DOM。 */
export function ZoomableImage({
  className,
  node: _node,
  onClick,
  ...props
}: Props) {
  const open = (event: MouseEvent<HTMLImageElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    const image = event.currentTarget;
    const src = image.currentSrc || image.src;
    if (src) openImageLightbox(src, image.alt);
  };
  return (
    <img
      {...props}
      alt={props.alt ?? ""}
      className={cn("cursor-zoom-in", className)}
      onClick={open}
    />
  );
}
