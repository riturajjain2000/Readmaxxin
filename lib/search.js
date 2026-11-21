/**
 * Find non-overlapping literal matches in one reading block.
 *
 * Offsets are UTF-16 offsets, matching DOM Text offsets and Range.setStart/end.
 * A regular expression supplies Unicode-aware case folding without lowercasing
 * the source text, which could change its length and invalidate DOM offsets.
 */
export function findTextMatches(text, query) {
  if (typeof text !== 'string' || typeof query !== 'string' || !query.length) return [];
  const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(literal, 'giu');
  return Array.from(text.matchAll(pattern), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/**
 * Search independent reading blocks without matching across their boundaries.
 * The caller joins inline text nodes within each group's text and maps the
 * resulting offsets back to DOM ranges. Group metadata is left untouched.
 */
export function findMatches(groups, query) {
  if (!Array.isArray(groups) || typeof query !== 'string' || !query.length) return [];
  return groups.flatMap((group, groupIndex) =>
    findTextMatches(group?.text, query).map((match) => ({ groupIndex, ...match })),
  );
}
