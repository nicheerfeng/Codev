export type NoteItem = {
  id: string;
  text: string;
  done: boolean;
};

export type NoteProject = {
  id: string;
  name: string;
  items: NoteItem[];
  locked?: boolean;
};

export type NotePad = {
  projects: NoteProject[];
};

export type NoteListId = string;
export const TMP_PROJECT_ID = "tmp";
