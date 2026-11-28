import { splitSkillMentions } from "./skillMention";

/** 气泡里只显示 $name，路径留在 title，不进正文。 */
export function SkillMentionText({
  text,
  onOpen,
}: {
  text: string;
  onOpen?: (path: string) => void;
}) {
  return (
    <>
      {splitSkillMentions(text).map((part, index) =>
        part.kind === "skill" ? (
          <button
            key={`${part.name}:${part.path}:${index}`}
            type="button"
            title={part.path || part.name}
            className="rounded-sm px-0.5 font-medium text-sky-600 hover:underline dark:text-sky-400"
            onClick={() => part.path && onOpen?.(part.path)}
          >
            ${part.name}
          </button>
        ) : (
          <span key={`text:${index}`}>{part.text}</span>
        ),
      )}
    </>
  );
}
