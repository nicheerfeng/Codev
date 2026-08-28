import type { Theme } from "../types";

export const codevDefault: Theme = {
  id: "codev-default",
  name: "Codev Default",
  description: "The default Codev look — clean glass over neutral surfaces.",
  editorTheme: { dark: "codium-dark", light: "codium-light" },
  variants: {
    light: {},
    dark: {},
  },
};
