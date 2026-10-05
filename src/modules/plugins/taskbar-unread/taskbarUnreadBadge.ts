const SIZE = 32;

function circle(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
) {
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.beginPath();
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, Math.PI * 2);
  ctx.fillStyle = "#477faf";
  ctx.fill();
}

function drawLabel(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  label: string,
) {
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${label.length > 1 ? 16 : 18}px sans-serif`;
  ctx.fillText(label, SIZE / 2, SIZE / 2 + 1);
}

export function unreadBadgeLabel(count: number) {
  if (count <= 0) return "";
  return count > 9 ? "9+" : String(count);
}

/** 画 Windows 任务栏 overlay 用的蓝底数字章。 */
export function renderUnreadBadgePng(count: number): Uint8Array | null {
  const label = unreadBadgeLabel(count);
  if (!label || typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  circle(ctx);
  drawLabel(ctx, label);
  const data = canvas.toDataURL("image/png");
  const comma = data.indexOf(",");
  if (comma < 0) return null;
  const binary = atob(data.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}
