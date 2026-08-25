// Telegram usernames arrive from the API without a leading "@", but stored
// `telegram_username` values are inconsistent — most carry a "@", some don't
// (a data-entry drift). Matching must therefore ignore the "@" entirely, or a
// member whose row happens to lack it silently fails every admin/member gate
// (this locked admins out of /quickcode). Returns two ilike patterns matching
// either stored form; LIKE metacharacters are escaped because Telegram handles
// legally contain "_" (an unescaped "_" is a single-char wildcard).
export function telegramIlikePatterns(username: string): { bare: string; withAt: string } | null {
  const bare = username.replace(/^@+/, "").trim();
  if (!bare) return null;
  const esc = bare.replace(/([\\%_])/g, "\\$1");
  return { bare: esc, withAt: `@${esc}` };
}
