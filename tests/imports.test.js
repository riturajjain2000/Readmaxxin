import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFile, validateFile, inspectDocxArchive, groupPdfTextItems,
  MAX_FILE_BYTES, MAX_TEXT_CHARACTERS, MAX_DOCX_ENTRY_BYTES,
} from '../lib/imports.js';

const encoder = new TextEncoder();
const documentParts = [
  { name: '[Content_Types].xml', data: '<Types/>' },
  { name: 'word/document.xml', data: '<w:document/>' },
];

// A small ZIP fixture builder lets the preflight tests control declared sizes
// and ZIP metadata without depending on the converter or a compression library.
function zipFixture(parts = documentParts) {
  const localParts = [];
  const directoryParts = [];
  let localOffset = 0;
  for (const part of parts) {
    const name = encoder.encode(part.name);
    const data = part.payload || encoder.encode(part.data || 'x');
    const local = new Uint8Array(30 + name.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(6, part.flags || 0, true);
    localView.setUint16(8, part.method || 0, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, part.expanded ?? data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    localParts.push(local);
    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(8, part.flags || 0, true);
    centralView.setUint16(10, part.method || 0, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, part.expanded ?? data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    directoryParts.push(central);
    localOffset += local.length;
  }
  const directorySize = directoryParts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(localOffset + directorySize + 22);
  let offset = 0;
  for (const part of [...localParts, ...directoryParts]) { output.set(part, offset); offset += part.length; }
  const end = new DataView(output.buffer, offset);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, parts.length, true);
  end.setUint16(10, parts.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, localOffset, true);
  return output.buffer;
}

function textFile(name, text) {
  return { name, size: encoder.encode(text).length, text: async () => text };
}

test('recognizes supported file names case-insensitively and validates size/type', () => {
  for (const [name, format] of [['notes.TXT', 'txt'], ['notes.md', 'markdown'], ['notes.markdown', 'markdown'], ['notes.HTM', 'html'], ['notes.html', 'html'], ['notes.pdf', 'pdf'], ['notes.docx', 'docx']]) {
    assert.equal(validateFile({ name, size: 1 }), format);
  }
  assert.throws(() => validateFile({ name: 'notes.rtf', size: 20 }), /TXT, Markdown, HTML, PDF, or DOCX/);
  assert.throws(() => validateFile({ name: 'notes.txt', size: 0 }), /empty/);
  assert.throws(() => validateFile({ name: 'notes.txt', size: MAX_FILE_BYTES + 1 }), /15 MB/);
});

test('escapes plain text, preserves its original source, and sanitizes the result', async () => {
  const source = 'A < B & C\n\nFinal line';
  const seen = [];
  const result = await parseFile(textFile('reading.txt', source), { sanitize: (html) => { seen.push(html); return html; } });
  assert.equal(result.html, '<p>A &lt; B &amp; C</p><p><br></p><p>Final line</p>');
  assert.equal(result.sourceSnapshot, source);
  assert.equal(result.filename, 'reading.txt');
  assert.equal(result.title, 'reading');
  assert.equal(result.format, 'txt');
  assert.equal(seen.length, 1);
});

test('routes Markdown through the supplied parser and every output through sanitization', async () => {
  let markdownSource;
  const result = await parseFile(textFile('reading.md', '# Heading'), {
    markdownToHTML: (text) => { markdownSource = text; return '<h1>Heading</h1>'; },
    sanitize: (html) => `safe:${html}`,
  });
  assert.equal(markdownSource, '# Heading');
  assert.equal(result.html, 'safe:<h1>Heading</h1>');
  const malicious = '<p>Good</p><script>bad()</script>';
  const html = await parseFile(textFile('reading.html', malicious), { sanitize: () => '<p>Good</p>' });
  assert.equal(html.sourceSnapshot, malicious);
  assert.equal(html.html, '<p>Good</p>');
  await assert.rejects(parseFile(textFile('reading.html', malicious)), /sanitizer/);
});

test('rejects oversized decoded text and malformed PDF before loading a parser', async () => {
  const file = { name: 'large.txt', size: 1, text: async () => 'a'.repeat(MAX_TEXT_CHARACTERS + 1) };
  await assert.rejects(parseFile(file, { sanitize: (html) => html }), /more text than the import limit/);
  const invalidPDF = encoder.encode('This is text, not PDF.').buffer;
  await assert.rejects(parseFile({ name: 'fake.pdf', size: invalidPDF.byteLength, arrayBuffer: async () => invalidPDF }, { sanitize: (html) => html }), /does not contain a PDF/);
});

test('accepts a bounded DOCX ZIP directory and rejects archives missing Word parts', () => {
  const summary = inspectDocxArchive(zipFixture());
  assert.equal(summary.entries, 2);
  assert.equal(summary.expandedBytes, encoder.encode('<Types/><w:document/>').length);
  assert.throws(() => inspectDocxArchive(zipFixture([{ name: 'hello.txt', data: 'hello' }])), /valid Word document/);
});

test('rejects ZIP bombs by entry expansion, aggregate expansion, and compression ratio', () => {
  const data = new Uint8Array(200_000);
  assert.throws(() => inspectDocxArchive(zipFixture([...documentParts, { name: 'word/large.xml', payload: data, expanded: MAX_DOCX_ENTRY_BYTES + 1, method: 8 }])), /safe import limit/);
  const chunks = ['a', 'b', 'c', 'd'].map((name) => ({ name: `word/${name}.xml`, payload: data, expanded: 20 * 1024 * 1024, method: 8 }));
  assert.throws(() => inspectDocxArchive(zipFixture([...documentParts, ...chunks])), /safe import limit/);
  assert.throws(() => inspectDocxArchive(zipFixture([...documentParts, { name: 'word/bomb.xml', data: 'x', expanded: 1000, method: 8 }])), /safe import limit/);
});

test('rejects encrypted, duplicate, traversing, and truncated ZIP structures', () => {
  assert.throws(() => inspectDocxArchive(zipFixture([{ ...documentParts[0], flags: 1 }, documentParts[1]])), /Password-protected/);
  assert.throws(() => inspectDocxArchive(zipFixture([...documentParts, { name: 'word/document.xml' }])), /duplicate archive paths/);
  assert.throws(() => inspectDocxArchive(zipFixture([...documentParts, { name: '../outside.xml' }])), /invalid or duplicate archive paths/);
  const truncated = zipFixture().slice(0, -1);
  assert.throws(() => inspectDocxArchive(truncated), /incomplete ZIP directory/);
});

test('DOCX conversion preserves a binary source copy and disables external file access', async () => {
  const original = zipFixture();
  const before = new Uint8Array(original).slice();
  const previous = globalThis.mammoth;
  let options;
  globalThis.mammoth = {
    images: { imgElement: (callback) => callback },
    convertToHtml: async (input, receivedOptions) => {
      options = receivedOptions;
      new Uint8Array(input.arrayBuffer).fill(0);
      return { value: '<h1>Title</h1><p>Text</p>', messages: [{ type: 'warning', message: 'A style was simplified.' }] };
    },
  };
  try {
    const result = await parseFile({ name: 'reading.docx', size: original.byteLength, arrayBuffer: async () => original }, { sanitize: (html) => html });
    assert.ok(result.sourceSnapshot instanceof ArrayBuffer);
    assert.deepEqual(new Uint8Array(result.sourceSnapshot), before);
    assert.deepEqual(new Uint8Array(original), before);
    assert.equal(options.externalFileAccess, false);
    assert.equal(options.includeEmbeddedStyleMap, false);
    assert.deepEqual(result.warnings, ['A style was simplified.']);
  } finally { if (previous === undefined) delete globalThis.mammoth; else globalThis.mammoth = previous; }
});

function pdfItem(str, x, y, { width = str.length * 6, hasEOL = false } = {}) {
  return { str, transform: [12, 0, 0, 12, x, y], width, height: 12, hasEOL };
}

test('groups PDF text fragments and wrapped lines without merging separate paragraphs', () => {
  const items = [
    pdfItem('Inductive', 10, 700, { width: 54 }),
    pdfItem('bias', 68, 700, { hasEOL: true }),
    pdfItem('guides learning.', 10, 684, { hasEOL: true }),
    pdfItem('A separate paragraph.', 10, 640, { hasEOL: true }),
  ];
  assert.deepEqual(groupPdfTextItems(items), ['Inductive bias guides learning.', 'A separate paragraph.']);
});

test('keeps PDF punctuation and bullets readable and handles empty/scanned pages', () => {
  const items = [
    pdfItem('Hello', 10, 700, { width: 30 }), pdfItem(',', 40, 700, { width: 3 }),
    pdfItem('world.', 48, 700, { hasEOL: true }),
    pdfItem('• First point', 10, 684, { hasEOL: true }),
    pdfItem('• Second point', 10, 668, { hasEOL: true }),
  ];
  assert.deepEqual(groupPdfTextItems(items), ['Hello, world.', '• First point', '• Second point']);
  assert.deepEqual(groupPdfTextItems([{ type: 'beginMarkedContent' }]), []);
  assert.deepEqual(groupPdfTextItems([]), []);
});

test('repairs a word broken by a PDF line-wrap hyphen', () => {
  assert.deepEqual(groupPdfTextItems([
    pdfItem('general-', 10, 700, { hasEOL: true }),
    pdfItem('ization', 10, 684, { hasEOL: true }),
  ]), ['generalization']);
});
