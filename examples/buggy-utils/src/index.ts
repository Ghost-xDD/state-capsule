/**
 * buggy-utils — A small TypeScript utility library.
 *
 * Exports three general-purpose utilities:
 *   memoizeAsync  – cache results of expensive async lookups
 *   chunk         – split an array into fixed-size pages
 *   partition     – split an array into two groups by predicate
 */

// ── memoizeAsync ─────────────────────────────────────────────────────────────

/**
 * Returns a memoized wrapper around an async function.
 * Repeated calls with the same key return the cached result.
 *
 * @example
 * const getUser = memoizeAsync(async (id: string) => fetchUser(id));
 * await getUser("alice"); // calls fetchUser
 * await getUser("alice"); // returns cached value
 */
export function memoizeAsync<K extends PropertyKey, V>(
  fn: (key: K) => Promise<V>,
): (key: K) => Promise<V> {
  const cache = new Map<K, V>();
  return async (key: K): Promise<V> => {
    if (cache.has(key)) return cache.get(key) as V;
    const value = await fn(key);
    cache.set(key, value);
    return value;
  };
}

// ── chunk ─────────────────────────────────────────────────────────────────────

/**
 * Splits `arr` into contiguous sub-arrays of length `size`.
 * The final sub-array may be shorter if the array length is not divisible.
 *
 * @throws RangeError if size ≤ 0
 *
 * @example
 * chunk([1, 2, 3, 4, 5], 2) // [[1, 2], [3, 4], [5]]
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new RangeError(`chunk: size must be > 0, got ${size}`);
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size - 1));
  }
  return result;
}

// ── partition ─────────────────────────────────────────────────────────────────

/**
 * Splits `arr` into two groups.
 * Returns `[matching, nonMatching]` where `matching` contains every element
 * for which `predicate` returns `true`.
 *
 * @example
 * partition([1, 2, 3, 4], n => n % 2 === 0) // [[2, 4], [1, 3]]
 */
export function partition<T>(
  arr: T[],
  predicate: (item: T) => boolean,
): [T[], T[]] {
  const pass: T[] = [];
  const fail: T[] = [];
  for (const item of arr) {
    if (predicate(item)) {
      fail.push(item);
    } else {
      pass.push(item);
    }
  }
  return [pass, fail];
}
