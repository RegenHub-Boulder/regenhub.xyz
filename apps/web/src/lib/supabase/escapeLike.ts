/** Escape `\`, `%` and `_` so a value matches itself in a LIKE / ilike pattern (PostgREST `.ilike`). */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
