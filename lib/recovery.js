const metadata = ['schemaVersion', 'title', 'sourceFormat', 'filename', 'importedAt', 'contentHtml', 'scrollTop', 'updatedAt'];

// A bounded, synchronous shutdown journal complements asynchronous IndexedDB.
// It never includes credentials, explanation history, or annotation state.
export function recoverySnapshot(workspace, maxCharacters = 1_000_000) {
  if (typeof workspace?.contentHtml !== 'string' || workspace.contentHtml.length > maxCharacters) return null;
  const journal = {};
  for (const key of metadata) if (workspace[key] !== undefined) journal[key] = workspace[key];
  if (typeof workspace.sourceSnapshot === 'string' && workspace.sourceSnapshot.length < 100_000) journal.sourceSnapshot = workspace.sourceSnapshot;
  return journal;
}

export function recoverWorkspace(saved, journal) {
  if (!journal || typeof journal.contentHtml !== 'string' || !Number.isFinite(journal.updatedAt) || journal.updatedAt <= (saved?.updatedAt || 0)) return saved;
  const safe = recoverySnapshot(journal);
  if (!safe) return saved;
  const sameSource = saved && saved.filename === safe.filename && saved.importedAt === safe.importedAt;
  return { ...safe, sourceSnapshot: safe.sourceSnapshot ?? (sameSource ? saved.sourceSnapshot : '') };
}
