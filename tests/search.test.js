import test from 'node:test';
import assert from 'node:assert/strict';
import { findMatches, findTextMatches } from '../lib/search.js';

test('finds a phrase across inline formatting flattened into one group', () => {
  const inlineSegments = ['Transformers have an ', 'inductive ', 'bias', ' toward patterns.'];
  assert.deepEqual(findMatches([{ text: inlineSegments.join('') }], 'INDUCTIVE BIAS'), [
    { groupIndex: 0, start: 21, end: 35 },
  ]);
});

test('never matches a phrase across separate paragraph or block groups', () => {
  const groups = [
    { text: 'An inductive ' },
    { text: 'bias can guide learning.' },
    { text: 'Inductive bias belongs to this paragraph.' },
  ];
  assert.deepEqual(findMatches(groups, 'inductive bias'), [
    { groupIndex: 2, start: 0, end: 14 },
  ]);
});

test('treats regular expression metacharacters as literal reading text', () => {
  const literal = 'a+b? (x)[y]. * ^ $ {z} \\';
  const text = `Prefix ${literal} suffix`;
  assert.deepEqual(findTextMatches(text, literal), [{ start: 7, end: 7 + literal.length }]);
  assert.deepEqual(findTextMatches('ab axb a.b', 'a.b'), [{ start: 7, end: 10 }]);
});

test('returns UTF-16 offsets that map to DOM text ranges around emoji', () => {
  const text = '🙂 Café / café';
  const matches = findTextMatches(text, 'CAFÉ');
  assert.deepEqual(matches, [{ start: 3, end: 7 }, { start: 10, end: 14 }]);
  assert.deepEqual(matches.map(({ start, end }) => text.slice(start, end)), ['Café', 'café']);
  assert.deepEqual(findTextMatches('🙂🙂x', '🙂'), [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
});

test('uses Unicode case folding without changing source offsets', () => {
  assert.deepEqual(findTextMatches('K K k', 'k'), [
    { start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 },
  ]);
});

test('returns duplicate non-overlapping matches in reading order', () => {
  assert.deepEqual(findMatches([{ text: 'banana banana' }, { text: 'ANA' }], 'ana'), [
    { groupIndex: 0, start: 1, end: 4 },
    { groupIndex: 0, start: 8, end: 11 },
    { groupIndex: 1, start: 0, end: 3 },
  ]);
});

test('preserves spaces as literal query content and handles empty queries', () => {
  assert.deepEqual(findTextMatches('a  b', '  '), [{ start: 1, end: 3 }]);
  assert.deepEqual(findMatches([{ text: 'a' }], ''), []);
  assert.deepEqual(findTextMatches('', 'a'), []);
  assert.deepEqual(findMatches([], 'a'), []);
});

test('does not mutate group metadata and ignores missing text safely', () => {
  const groups = Object.freeze([
    Object.freeze({ text: 'term', blockId: 'p1' }),
    Object.freeze({ blockId: 'p2' }),
    Object.freeze({ text: 'TERM', blockId: 'p3' }),
  ]);
  assert.deepEqual(findMatches(groups, 'term'), [
    { groupIndex: 0, start: 0, end: 4 },
    { groupIndex: 2, start: 0, end: 4 },
  ]);
  assert.equal(groups[0].blockId, 'p1');
});
