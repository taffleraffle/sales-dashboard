// Paginate a Supabase query through PostgREST's 1000-row default cap.
// Pass a function that returns a fresh query builder; we add `.range()` on
// each page. Without this, queries like `supabase.from('ads').select('*')`
// silently truncate at 1000 rows the moment the table grows — and the
// caller has no idea their "total" is wrong.
export async function pagedFetch(queryBuilder) {
  const PAGE = 1000
  const out = []
  let off = 0
  while (true) {
    const { data, error } = await queryBuilder().range(off, off + PAGE - 1)
    if (error) throw new Error(error.message)
    if (!data || !data.length) break
    out.push(...data)
    if (data.length < PAGE) break
    off += PAGE
  }
  return out
}
