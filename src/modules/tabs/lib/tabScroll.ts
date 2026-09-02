/** 将鼠标滚轮或触控板增量转换为标签栏横向像素位移。 */
export function tabWheelDelta(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
  viewportWidth: number,
): number {
  const delta = Math.abs(deltaX) >= Math.abs(deltaY) ? deltaX : deltaY;
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * viewportWidth;
  return delta;
}
