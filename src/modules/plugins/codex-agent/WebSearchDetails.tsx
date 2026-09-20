import { MarkdownLink } from "@/modules/markdown/MarkdownLink";
import { itemText, type Item } from "./protocol";

/** 展示原生搜索动作和上游实际返回的来源，不虚构未提供的搜索结果。 */
export function WebSearchDetails({ item }: { item: Item }) {
  const action = item.action as { url?: string } | null;
  const results = Array.isArray(item.results) ? item.results as Array<{ url?: string; title?: string; snippet?: string; description?: string }> : [];
  return <div className="space-y-2 text-xs">
    <p>{itemText(item)}</p>
    {action?.url && /^https?:\/\//i.test(action.url) && <MarkdownLink href={action.url} className="text-primary underline">{action.url}</MarkdownLink>}
    {results.map((result, index) => <div key={index}>
      {typeof result.url === "string" && /^https?:\/\//i.test(result.url)
        ? <MarkdownLink href={result.url} className="text-primary underline">{result.title || result.url}</MarkdownLink>
        : typeof result.title === "string" ? <span>{result.title}</span> : null}
      {(result.snippet || result.description) && <p className="text-muted-foreground">{result.snippet || result.description}</p>}
    </div>)}
    <details><summary className="cursor-pointer text-[10px]">调用详情</summary><pre>{JSON.stringify(item, null, 2)}</pre></details>
  </div>;
}
