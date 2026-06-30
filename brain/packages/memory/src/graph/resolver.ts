/**
 * Wikilink slug resolver.
 *
 * Maps `[[slug]]` and `[[scope:slug]]` references emitted in
 * extracted markdown bodies to existing chunk IDs in the SQLite
 * index. Lives outside the Storage interface so the graph layer
 * can rebuild it lazily after disk-side reconciliation (the
 * daemon's link-fix phase) without holding the index hostage to
 * a particular storage shape.
 *
 * Today the index is in-memory: each Memory instance keeps a
 * SlugResolver populated at flush time. Production callers will
 * back it with the same SQLite store that holds chunks; the API
 * stays identical so swapping is a constructor change.
 */

export interface SlugResolver {
  /** Register `slug` → `chunkId` for the resolver's scope. */
  register(slug: string, chunkId: string): void;
  /**
   * Resolve a wikilink target. Unscoped lookups are local to the
   * registering scope; scoped lookups (`[[other-scope:slug]]`)
   * fall through to a global registry when a sibling resolver
   * has been seeded.
   */
  resolve(slug: string, scope?: string): string | undefined;
  /** Number of registered slug → chunkId mappings. */
  size(): number;
}

export function createSlugResolver(): SlugResolver {
  const local = new Map<string, string>();
  return {
    register(slug, chunkId) {
      local.set(canonical(slug), chunkId);
    },
    resolve(slug, _scope) {
      // Cross-scope resolution is reserved for the production
      // daemon — within-Memory it falls back to local lookup.
      return local.get(canonical(slug));
    },
    size() {
      return local.size;
    },
  };
}

function canonical(slug: string): string {
  return slug.trim().toLowerCase().replace(/^\[\[/, "").replace(/\]\]$/, "");
}
