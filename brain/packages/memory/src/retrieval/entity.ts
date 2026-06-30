/**
 * Lightweight entity resolution.
 *
 * Jeff's Lever C from `[[research/jeffs-brain-architecture]]`:
 * canonicalise entities across memories so a query mentioning "Alex
 * from Germany" surfaces every chunk tagged with that canonical
 * entity, even when chunks use different aliases.
 *
 * This module provides:
 *  - `extractQueryEntities`: a regex-based NER over query text.
 *    Captures sequences of capitalised words (proper nouns) and
 *    "<name> from <place>" qualifier patterns.
 *  - `EntityIndex`: in-memory bag of chunk-ids keyed by canonical
 *    entity (lowercased). Populated at write time from chunks'
 *    `metadata.entities` array.
 *  - `findChunksByQueryEntities`: at retrieve time, takes the index
 *    and a query, returns the chunk-ids that match any query entity.
 *
 * v1 is deliberately simple — exact-prefix match between query
 * entities and indexed entities, both lower-cased. Aliasing
 * ("Alex" ↔ "Alex from Germany") is handled by partial match: the
 * shorter entity matches if it's a prefix of the longer one. v2
 * could add learned alias clusters via LLM, but v1 covers the bulk
 * of LongMemEval's failure shapes.
 */

const STOPWORDS = new Set([
  "I",
  "Me",
  "My",
  "Mine",
  "We",
  "Us",
  "Our",
  "Ours",
  "You",
  "Your",
  "Yours",
  "He",
  "She",
  "It",
  "They",
  "Them",
  "Their",
  "The",
  "A",
  "An",
  "And",
  "Or",
  "But",
  "Of",
  "In",
  "On",
  "At",
  "To",
  "From",
  "By",
  "With",
  "For",
  "How",
  "What",
  "When",
  "Where",
  "Who",
  "Why",
  "Which",
  "Did",
  "Do",
  "Does",
  "Have",
  "Has",
  "Had",
  "Was",
  "Were",
  "Is",
  "Are",
  "Be",
  "Been",
  "Many",
  "Much",
  "Total",
  "Most",
  "First",
  "Second",
  "Third",
  "Last",
  "Recently",
  "Year",
  "Month",
  "Week",
  "Day",
  "Today",
  "Yesterday",
]);

/**
 * Pull candidate entities from a query string. Returns lowercased
 * canonical forms.
 *
 * Heuristics:
 *  - Sequences of capitalised words (≥1 word, no stopwords): "Alex",
 *    "New York", "Sarah Mike Wedding".
 *  - "<X> from <Y>" patterns: "Alex from Germany" → both "alex" and
 *    "alex from germany".
 */
export function extractQueryEntities(query: string): string[] {
  const out = new Set<string>();
  // Match sequences of TitleCase words, plus optional " from <Title>".
  const re =
    /\b((?:[A-Z][a-zA-Z]*)(?:\s+[A-Z][a-zA-Z]*)*)\b(?:\s+from\s+([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)*))?/g;
  for (const m of query.matchAll(re)) {
    const name = m[1];
    const qualifier = m[2];
    if (name === undefined) continue;
    const tokens = name.split(/\s+/).filter((t) => !STOPWORDS.has(t));
    if (tokens.length === 0) continue;
    const cleanName = tokens.join(" ").toLowerCase();
    if (cleanName.length < 2) continue;
    out.add(cleanName);
    if (qualifier !== undefined) {
      const qualifierClean = qualifier
        .split(/\s+/)
        .filter((t) => !STOPWORDS.has(t))
        .join(" ")
        .toLowerCase();
      if (qualifierClean.length > 0) {
        out.add(`${cleanName} from ${qualifierClean}`);
      }
    }
  }
  return [...out];
}

/**
 * In-memory entity index. Maps each canonical entity (lowercased) to
 * the set of chunk ids that mention it. Populated at write time from
 * extracted-fact chunks' `metadata.entities` array.
 *
 * Doubles as the **entity-popularity counter** for the backlink boost
 * (GBrain-style score *= 1 + 0.05 · log(1 + popularity)). Popularity
 * for a chunk is the max number of co-mentioning chunks across the
 * chunk's entities — a graph-density signal that lifts facts about
 * heavily-discussed entities without any extra LLM call.
 */
export class EntityIndex {
  private readonly byEntity = new Map<string, Set<string>>();
  private readonly byChunk = new Map<string, Set<string>>();

  add(chunkId: string, entities: readonly string[]): void {
    const chunkSet = this.byChunk.get(chunkId) ?? new Set<string>();
    for (const e of entities) {
      const key = e.trim().toLowerCase();
      if (key === "") continue;
      const set = this.byEntity.get(key) ?? new Set<string>();
      set.add(chunkId);
      this.byEntity.set(key, set);
      chunkSet.add(key);
    }
    if (chunkSet.size > 0) this.byChunk.set(chunkId, chunkSet);
  }

  /**
   * Find chunk ids that match any query entity. A query entity matches
   * an indexed entity if the query entity is a substring of the
   * indexed entity, OR the indexed entity is a prefix of the query
   * entity (handling "Alex" ↔ "Alex from Germany"). Returns the union
   * of matched chunk-id sets.
   */
  findChunksByQueryEntities(queryEntities: readonly string[]): Set<string> {
    const result = new Set<string>();
    if (queryEntities.length === 0) return result;
    for (const [indexed, chunkIds] of this.byEntity.entries()) {
      for (const q of queryEntities) {
        if (indexed.includes(q) || q.startsWith(indexed)) {
          for (const id of chunkIds) result.add(id);
          break;
        }
      }
    }
    return result;
  }

  /**
   * Backlink popularity for a chunk: how often the most-mentioned of
   * its entities appears across the rest of the index. Used by
   * `applyBacklinkBoost` at retrieval time. A chunk that mentions an
   * entity referenced by 20 other facts is "central" in the graph and
   * gets a multiplicative score boost. Chunks with no entities — or
   * entities mentioned only by themselves — score 0 and are unboosted.
   *
   * Subtract 1 because `byEntity[e]` includes the chunk itself; the
   * caller wants the *outbound* count, not self.
   */
  popularityFor(chunkId: string): number {
    const entities = this.byChunk.get(chunkId);
    if (entities === undefined || entities.size === 0) return 0;
    let max = 0;
    for (const e of entities) {
      const refCount = this.byEntity.get(e)?.size ?? 0;
      const others = Math.max(0, refCount - 1);
      if (others > max) max = others;
    }
    return max;
  }

  /** Diagnostics: number of distinct entities indexed. */
  size(): number {
    return this.byEntity.size;
  }

  /** Diagnostics: number of chunks tagged for an entity. */
  chunksFor(entity: string): number {
    return this.byEntity.get(entity.toLowerCase())?.size ?? 0;
  }
}
