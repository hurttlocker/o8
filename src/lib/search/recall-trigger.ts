export const RECALL_MIN_QUERY_LENGTH = 3;
export const RECALL_KEYWORD_HIT_LIMIT = 5;

export function shouldRequestRecall(query: string, keywordHits: number): boolean {
  return query.trim().length >= RECALL_MIN_QUERY_LENGTH
    && Number.isInteger(keywordHits)
    && keywordHits >= 0
    && keywordHits < RECALL_KEYWORD_HIT_LIMIT;
}
