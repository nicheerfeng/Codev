export type NoteItem = {
  id: string;
  text: string;
  done: boolean;
  createdAt?: number;
  updatedAt?: number;
  doneAt?: number | null;
  deletedAt?: number | null;
};

export type NoteProject = {
  id: string;
  name: string;
  items: NoteItem[];
  locked?: boolean;
  collapsed?: boolean;
  doneCollapsed?: boolean;
  createdAt?: number;
  updatedAt?: number;
  deletedAt?: number | null;
};

export type NotePad = {
  projects: NoteProject[];
};

export type NoteListId = string;
export const TMP_PROJECT_ID = "tmp";
