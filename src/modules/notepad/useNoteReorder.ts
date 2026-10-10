import {
  useCallback,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { NoteListId } from "./types";

/** 用指针捕获重排记事项，待办可跨组，项目标题只改组顺序。 */
export function useNoteReorder(onMove: (from: number, to: number) => void) {
  const drag = useRef<{
    from: number;
    pointerId: number;
    startY: number;
    active: boolean;
    target: HTMLElement;
  } | null>(null);

  const end = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    if (current?.target.hasPointerCapture(current.pointerId)) {
      current.target.releasePointerCapture(current.pointerId);
    }
  }, []);

  const props = (index: number) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      drag.current = {
        from: index,
        pointerId: event.pointerId,
        startY: event.clientY,
        active: false,
        target: event.currentTarget,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (!current.active && Math.abs(event.clientY - current.startY) < 4)
        return;
      current.active = true;
      event.preventDefault();
    },
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const list = event.currentTarget.closest("[data-note-projects]");
      const rows = list
        ? Array.from(list.querySelectorAll<HTMLElement>("[data-note-project]"))
        : [];
      const to = rows.findIndex((node) => {
        const rect = node.getBoundingClientRect();
        return event.clientY < rect.top + rect.height / 2;
      });
      const target = to < 0 ? rows.length - 1 : to;
      if (current.active && target >= 0 && target !== current.from)
        onMove(current.from, target);
      end();
    },
    onPointerCancel: end,
  });

  return props;
}

export function useNoteItemReorder(
  listId: NoteListId,
  onMove: (
    fromList: NoteListId,
    from: number,
    toList: NoteListId,
    to: number,
  ) => void,
) {
  const drag = useRef<{
    from: number;
    pointerId: number;
    startY: number;
    active: boolean;
    target: HTMLElement;
  } | null>(null);

  const end = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    if (current?.target.hasPointerCapture(current.pointerId)) {
      current.target.releasePointerCapture(current.pointerId);
    }
  }, []);

  const props = (index: number) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      drag.current = {
        from: index,
        pointerId: event.pointerId,
        startY: event.clientY,
        active: false,
        target: event.currentTarget,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (!current.active && Math.abs(event.clientY - current.startY) < 4)
        return;
      current.active = true;
      event.preventDefault();
    },
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const item = hit?.closest<HTMLElement>("[data-note-item]") ?? null;
      const project = hit?.closest<HTMLElement>("[data-note-project]") ?? null;
      let list = item?.closest<HTMLElement>("[data-note-list]") ?? null;
      if (!list && project) {
        list = project.querySelector<HTMLElement>("[data-note-list]");
      }
      if (!list) {
        list = hit?.closest<HTMLElement>("[data-note-list]") ?? null;
      }
      const toList = (list?.dataset.noteList ?? listId) as NoteListId;
      const rows = list
        ? Array.from(list.querySelectorAll<HTMLElement>("[data-note-item]"))
        : [];
      let to = rows.length;
      if (item) {
        to = rows.indexOf(item);
        const middle = item.getBoundingClientRect().top + item.offsetHeight / 2;
        if (event.clientY > middle) to += 1;
      } else {
        const before = rows.findIndex((row) => {
          const rect = row.getBoundingClientRect();
          return event.clientY < rect.top + rect.height / 2;
        });
        if (before >= 0) to = before;
      }
      if (current.active) onMove(listId, current.from, toList, to);
      end();
    },
    onPointerCancel: end,
  });

  return props;
}
