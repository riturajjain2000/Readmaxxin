import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverySnapshot, recoverWorkspace } from '../lib/recovery.js';

test('shutdown recovery restores newer manual edits and reading position while retaining the original binary source', () => {
  const source = new Uint8Array([1, 2, 3]).buffer;
  const saved = { filename: 'reading.docx', importedAt: 1, updatedAt: 10, contentHtml: '<p>Before</p>', sourceSnapshot: source };
  const journal = recoverySnapshot({ ...saved, updatedAt: 20, contentHtml: '<p>After an edit</p>', scrollTop: 800 });
  const restored = recoverWorkspace(saved, JSON.parse(JSON.stringify(journal)));
  assert.equal(restored.contentHtml, '<p>After an edit</p>'); assert.equal(restored.scrollTop, 800); assert.equal(restored.sourceSnapshot, source);
});
test('recovery never revives an older workspace or copies a different import source', () => {
  const saved = { filename: 'first.pdf', importedAt: 1, updatedAt: 50, sourceSnapshot: new ArrayBuffer(2), contentHtml: 'First' };
  assert.equal(recoverWorkspace(saved, { contentHtml: 'Old', updatedAt: 49 }), saved);
  assert.equal(recoverWorkspace(saved, { filename: 'second.pdf', importedAt: 2, updatedAt: 60, contentHtml: 'Second' }).sourceSnapshot, '');
});
test('journal is bounded and never persists AI state, secrets, or annotations', () => {
  const journal = recoverySnapshot({ contentHtml: 'Document', updatedAt: 1, apiKey: 'secret', highlights: ['term'], explanation: 'answer', sourceSnapshot: 'original' });
  assert.deepEqual(journal, { contentHtml: 'Document', updatedAt: 1, sourceSnapshot: 'original' });
  assert.equal(recoverySnapshot({ contentHtml: 'x'.repeat(11) }, 10), null);
  assert.equal(recoverWorkspace(undefined, { contentHtml: 'Bad', updatedAt: 'invalid' }), undefined);
});
