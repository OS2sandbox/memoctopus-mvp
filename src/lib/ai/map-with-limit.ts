// Like Promise.all(items.map(fn)) but with at most `limit` calls in flight. Results keep
// input order. On the first failure it rejects and starts no further tasks.
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;

  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
