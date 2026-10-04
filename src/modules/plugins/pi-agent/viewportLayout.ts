export const MAX_PI_VIEWPORTS = 6;

/** 将会话放入指定视口；已显示的会话交换位置，避免重复实例。 */
export function placePiSession(
  slots: (string | null)[],
  index: number,
  key: string | null,
): (string | null)[] {
  const next = [...slots];
  const previous = key === null ? -1 : next.indexOf(key);
  if (previous >= 0 && previous !== index) next[previous] = next[index];
  next[index] = key;
  return next;
}
