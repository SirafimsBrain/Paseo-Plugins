// Copy naming (stage 0.21.10). Dependency-free on purpose: the console
// bundle imports this without pulling zod into the browser.

/** Strip a trailing `_copy` / `_copy<n>` so copies chain off the original. */
export function copyNameRoot(name: string): string {
  return name.replace(/_copy\d*$/, "");
}

/**
 * Next free copy name: `name` → `name_copy` → `name_copy1` → `name_copy2` …
 * `taken` holds every existing connection name; the source name itself always
 * counts as taken, so duplicating `x_copy` yields `x_copy1`, never `x_copy`.
 */
export function nextCopyName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  used.add(name);
  const root = copyNameRoot(name);
  let candidate = `${root}_copy`;
  let n = 1;
  while (used.has(candidate)) {
    candidate = `${root}_copy${n}`;
    n += 1;
  }
  return candidate;
}
