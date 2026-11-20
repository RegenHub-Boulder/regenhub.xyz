/**
 * Every row a query matches, a page at a time, so PostgREST's row cap (1000 on our Supabase) can't shorten a list or
 * a count. `page(from, to)` must order by a unique column. Throws on a read error rather than return a short list.
 */
const PAGE = 1000;

export async function readAll<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
}
