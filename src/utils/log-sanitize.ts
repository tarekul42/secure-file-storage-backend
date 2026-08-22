const QUERY_MARKER = "?";

/**
 * Strips the query string from a URL before it is written to logs.
 * Query parameters can carry sensitive material (e.g. presigned-URL
 * signatures), so only the path portion is ever logged.
 */
export const sanitizeUrlForLog = (
  url: string | undefined,
): string | undefined => {
  if (!url) return url;
  const queryIndex = url.indexOf(QUERY_MARKER);
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
};
