export type TextSearchOptions = {
  caseSensitive: boolean;
};

export type TextSearchStatus = {
  count: number;
  index: number;
  truncated?: boolean;
  busy?: boolean;
};

export type TextSearchHandle = {
  setQuery: (query: string, options?: TextSearchOptions) => void;
  findNext: () => void;
  findPrevious: () => void;
  clearQuery: () => void;
  getSearchStatus: () => TextSearchStatus;
  subscribeSearchStatus: (
    listener: (status: TextSearchStatus) => void,
  ) => () => void;
  replaceCurrent: (replacement: string) => Promise<number>;
  replaceAll: (replacement: string) => Promise<number>;
};

/** 返回文本中所有非重叠字面量命中的 UTF-16 偏移。 */
export function findLiteralMatches(
  content: string,
  query: string,
  options: TextSearchOptions,
  limit = Number.POSITIVE_INFINITY,
): number[] {
  if (!query || limit <= 0) return [];
  const haystack = options.caseSensitive
    ? content
    : content.toLocaleLowerCase();
  const needle = options.caseSensitive ? query : query.toLocaleLowerCase();
  const matches: number[] = [];
  let offset = 0;
  while (offset <= haystack.length) {
    const match = haystack.indexOf(needle, offset);
    if (match < 0) break;
    matches.push(match);
    if (matches.length >= limit) break;
    offset = match + Math.max(needle.length, 1);
  }
  return matches;
}

/** 按给定命中位置替换文本，保持搜索口径为普通字面量匹配。 */
export function replaceLiteralMatch(
  content: string,
  query: string,
  replacement: string,
  options: TextSearchOptions,
  matchIndex: number,
): { content: string; count: number } {
  const matches = findLiteralMatches(content, query, options);
  const start = matches[matchIndex];
  if (start === undefined) return { content, count: 0 };
  return {
    content:
      content.slice(0, start) +
      replacement +
      content.slice(start + query.length),
    count: 1,
  };
}

/** 替换当前文本中的全部字面量命中。 */
export function replaceAllLiteralMatches(
  content: string,
  query: string,
  replacement: string,
  options: TextSearchOptions,
): { content: string; count: number } {
  if (!query) return { content, count: 0 };
  const matches = findLiteralMatches(content, query, options);
  if (matches.length === 0) return { content, count: 0 };
  let cursor = 0;
  let next = "";
  for (const start of matches) {
    next += content.slice(cursor, start) + replacement;
    cursor = start + query.length;
  }
  return { content: next + content.slice(cursor), count: matches.length };
}
