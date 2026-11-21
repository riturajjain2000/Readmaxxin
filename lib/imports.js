export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_TEXT_CHARACTERS = 2_000_000;
export const MAX_PDF_PAGES = 300;
export const MAX_PDF_TEXT_ITEMS = 250_000;
export const MAX_DOCX_EXPANDED_BYTES = 60 * 1024 * 1024;
export const MAX_DOCX_ENTRY_BYTES = 24 * 1024 * 1024;
export const MAX_DOCX_ENTRIES = 4096;
export const MAX_DOCX_COMPRESSION_RATIO = 200;
const MAX_EMBEDDED_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_ALL_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_HTML_CHARACTERS = 14_000_000;
const FORMATS = new Map([['txt', 'txt'], ['md', 'markdown'], ['markdown', 'markdown'], ['html', 'html'], ['htm', 'html'], ['pdf', 'pdf'], ['docx', 'docx']]);
let mammothLoading;

export class ImportError extends Error {
  constructor(message, code = 'invalid-file') { super(message); this.name = 'ImportError'; this.code = code; }
}

export function validateFile(file) {
  if (!file || typeof file.name !== 'string' || !Number.isFinite(file.size) || file.size < 0) throw new ImportError('Choose a readable document file.');
  if (file.size > MAX_FILE_BYTES) throw new ImportError('This file is larger than the 15 MB import limit.', 'file-too-large');
  if (file.size === 0) throw new ImportError('This file is empty.', 'empty-file');
  const extension = file.name.split('.').pop().toLowerCase();
  const format = FORMATS.get(extension);
  if (!format) throw new ImportError('Open a TXT, Markdown, HTML, PDF, or DOCX file.', 'unsupported-format');
  return format;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

/** Read ZIP metadata before asking Mammoth to inflate a DOCX archive. */
export function inspectDocxArchive(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new ImportError('This file is larger than the 15 MB import limit.', 'file-too-large');
  if (bytes.byteLength < 22) throw new ImportError('This DOCX file is not a valid ZIP document.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.byteLength - 22, first = Math.max(0, bytes.byteLength - 65557); offset >= first; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength) { end = offset; break; }
  }
  if (end < 0) throw new ImportError('This DOCX file has an incomplete ZIP directory.');
  const entries = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryStart = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== entries) throw new ImportError('Multipart DOCX archives are not supported.');
  if (entries === 0xffff || directorySize === 0xffffffff || directoryStart === 0xffffffff) throw new ImportError('ZIP64 DOCX archives are not supported.');
  if (!entries || entries > MAX_DOCX_ENTRIES) throw new ImportError('This DOCX archive contains too many parts.', 'archive-too-large');
  if (directoryStart + directorySize > end || directoryStart >= end) throw new ImportError('This DOCX file has an invalid ZIP directory.');
  const names = new Set();
  let expandedBytes = 0;
  let compressedBytes = 0;
  let position = directoryStart;
  for (let index = 0; index < entries; index++) {
    if (position + 46 > directoryStart + directorySize || view.getUint32(position, true) !== 0x02014b50) throw new ImportError('This DOCX file has a malformed ZIP entry.');
    const flags = view.getUint16(position + 8, true);
    const method = view.getUint16(position + 10, true);
    const compressed = view.getUint32(position + 20, true);
    const expanded = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const localOffset = view.getUint32(position + 42, true);
    const next = position + 46 + nameLength + extraLength + commentLength;
    if (next > directoryStart + directorySize || view.getUint16(position + 34, true)) throw new ImportError('This DOCX file has an invalid ZIP entry.');
    if (flags & 1) throw new ImportError('Password-protected DOCX files must be unlocked before import.', 'encrypted-file');
    if (![0, 8].includes(method) || [compressed, expanded, localOffset].includes(0xffffffff)) throw new ImportError('This DOCX uses an unsupported archive format.');
    if (expanded > MAX_DOCX_ENTRY_BYTES || expandedBytes + expanded > MAX_DOCX_EXPANDED_BYTES || (expanded && expanded / Math.max(1, compressed) > MAX_DOCX_COMPRESSION_RATIO)) throw new ImportError('This DOCX expands beyond the safe import limit.', 'archive-too-large');
    const name = new TextDecoder().decode(bytes.subarray(position + 46, position + 46 + nameLength));
    if (!name || name.includes('\0') || name.startsWith('/') || name.split(/[\\/]/).includes('..') || names.has(name)) throw new ImportError('This DOCX contains invalid or duplicate archive paths.');
    if (localOffset + 30 > directoryStart || view.getUint32(localOffset, true) !== 0x04034b50) throw new ImportError('This DOCX has an invalid local ZIP entry.');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const localName = new TextDecoder().decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    if (dataStart + compressed > directoryStart || localName !== name || view.getUint16(localOffset + 8, true) !== method || (view.getUint16(localOffset + 6, true) & 1)) throw new ImportError('This DOCX has inconsistent ZIP entries.');
    names.add(name);
    expandedBytes += expanded;
    compressedBytes += compressed;
    position = next;
  }
  if (position !== directoryStart + directorySize || !names.has('[Content_Types].xml') || !names.has('word/document.xml')) throw new ImportError('This ZIP file does not contain a valid Word document.');
  return { entries, expandedBytes, compressedBytes };
}

/** Group a PDF text-content sequence into readable paragraphs. No page is rendered. */
export function groupPdfTextItems(items) {
  const lines = [];
  let line;
  let previous;
  const flushLine = () => { if (line?.text.trim()) lines.push({ ...line, text: line.text.trim() }); line = undefined; previous = undefined; };
  for (const item of items || []) {
    if (typeof item.str !== 'string' || !item.str.length) { if (item.hasEOL) flushLine(); continue; }
    const transform = item.transform || [];
    const x = Number.isFinite(transform[4]) ? transform[4] : 0;
    const y = Number.isFinite(transform[5]) ? transform[5] : (line?.y ?? 0);
    const height = Math.max(1, Math.abs(transform[3] || item.height || 10));
    if (line && Math.abs(y - line.y) > Math.max(2, height * 0.45)) flushLine();
    if (!line) line = { text: '', x, y, height };
    if (line.text && !/\s$/.test(line.text) && !/^\s|^[,.;:!?%)\]}]/.test(item.str)) {
      const gap = previous && Number.isFinite(previous.width) ? x - previous.x - previous.width : height * 0.3;
      if (gap > Math.max(1, height * 0.14)) line.text += ' ';
    }
    line.text += item.str;
    line.height = Math.max(line.height, height);
    previous = { x, width: item.width };
    if (item.hasEOL) flushLine();
  }
  flushLine();
  const paragraphs = [];
  let paragraph = '';
  let last;
  const flushParagraph = () => { if (paragraph.trim()) paragraphs.push(paragraph.trim()); paragraph = ''; };
  for (const current of lines) {
    const verticalGap = last ? Math.abs(last.y - current.y) : 0;
    const bullet = /^(?:[•●▪◦]|[-–—]\s|\d+[.)]\s)/.test(current.text);
    if (last && (verticalGap > Math.max(last.height, current.height) * 1.8 || bullet || /^(?:[•●▪◦]|[-–—]\s|\d+[.)]\s)/.test(last.text))) flushParagraph();
    if (paragraph) {
      if (/\p{L}-$/u.test(paragraph) && /^\p{Ll}/u.test(current.text)) paragraph = paragraph.slice(0, -1);
      else paragraph += ' ';
    }
    paragraph += current.text;
    last = current;
  }
  flushParagraph();
  return paragraphs;
}

async function parsePDF(buffer, onProgress) {
  if (!new TextDecoder('latin1').decode(buffer.slice(0, 1024)).includes('%PDF-')) throw new ImportError('This file does not contain a PDF document.');
  const pdfjs = await import('/vendor/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';
  const loading = pdfjs.getDocument({ data: new Uint8Array(buffer.slice(0)), isEvalSupported: false, disableFontFace: true, enableXfa: false, stopAtErrors: true });
  let pdf;
  try {
    pdf = await loading.promise;
    if (pdf.numPages > MAX_PDF_PAGES) throw new ImportError(`PDF import is limited to ${MAX_PDF_PAGES} pages.`, 'file-too-large');
    const pages = [];
    let characters = 0;
    let itemCount = 0;
    let blankPages = 0;
    for (let index = 1; index <= pdf.numPages; index++) {
      onProgress?.(`Reading PDF page ${index} of ${pdf.numPages}…`);
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      itemCount += content.items.length;
      if (itemCount > MAX_PDF_TEXT_ITEMS) throw new ImportError('This PDF contains more text objects than the import limit.', 'file-too-large');
      const paragraphs = groupPdfTextItems(content.items);
      characters += paragraphs.reduce((sum, text) => sum + text.length, 0);
      if (characters > MAX_TEXT_CHARACTERS) throw new ImportError('This PDF contains more text than the import limit.', 'file-too-large');
      if (paragraphs.length) pages.push(paragraphs.map((text) => `<p>${escapeHTML(text)}</p>`).join(''));
      else blankPages++;
      page.cleanup();
    }
    if (!characters) throw new ImportError('This PDF has no selectable text. Scanned pages need OCR before they can be imported.', 'ocr-required');
    return { html: pages.join('<hr>'), warnings: blankPages ? [`${blankPages} PDF page${blankPages === 1 ? '' : 's'} had no selectable text and may need OCR.`] : [] };
  } catch (error) {
    if (error.name === 'PasswordException') throw new ImportError('Password-protected PDFs must be unlocked before import.', 'encrypted-file');
    if (error instanceof ImportError) throw error;
    throw new ImportError('This PDF could not be read. It may be damaged or use unsupported encryption.');
  } finally {
    // The loading task owns worker cleanup, including on PDF.js 6 where the
    // document proxy no longer exposes destroy().
    await loading.destroy().catch(() => {});
  }
}

function loadMammoth() {
  if (globalThis.mammoth?.convertToHtml) return Promise.resolve(globalThis.mammoth);
  if (!mammothLoading) mammothLoading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/mammoth.browser.js';
    script.async = true;
    script.onload = () => { if (globalThis.mammoth?.convertToHtml) resolve(globalThis.mammoth); else { mammothLoading = undefined; reject(new ImportError('The Word document parser could not be loaded.')); } };
    script.onerror = () => { script.remove(); mammothLoading = undefined; reject(new ImportError('The Word document parser could not be loaded.')); };
    document.head.append(script);
  });
  return mammothLoading;
}

async function parseDOCX(buffer, onProgress) {
  inspectDocxArchive(buffer);
  onProgress?.('Reading Word document…');
  const mammoth = await loadMammoth();
  const warnings = [];
  let imageBytes = 0;
  const convertImage = mammoth.images.imgElement(async (image) => {
    if (!/^image\/(?:png|jpeg|gif|webp)$/.test(image.contentType)) { warnings.push('An unsupported embedded image was omitted.'); return { alt: 'Unsupported embedded image' }; }
    const data = await image.readAsArrayBuffer();
    if (data.byteLength > MAX_EMBEDDED_IMAGE_BYTES || imageBytes + data.byteLength > MAX_ALL_IMAGE_BYTES) { warnings.push('A large embedded image was omitted.'); return { alt: 'Large embedded image omitted' }; }
    imageBytes += data.byteLength;
    return { src: `data:${image.contentType};base64,${await image.readAsBase64String()}` };
  });
  try {
    const result = await mammoth.convertToHtml({ arrayBuffer: buffer.slice(0) }, { externalFileAccess: false, includeEmbeddedStyleMap: false, ignoreEmptyParagraphs: false, convertImage });
    if (result.value.length > MAX_OUTPUT_HTML_CHARACTERS) throw new ImportError('The converted Word document exceeds the import limit.', 'file-too-large');
    for (const message of result.messages || []) if (message.type === 'warning' || message.type === 'error') warnings.push(String(message.message));
    if (!result.value.trim()) throw new ImportError('This Word document has no readable content.', 'empty-file');
    return { html: result.value, warnings: [...new Set(warnings)] };
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError('This Word document could not be read. It may be damaged or password-protected.');
  }
}

/** Parse without touching the reading surface; callers replace it only on success. */
export async function parseFile(file, { sanitize, markdownToHTML, onProgress } = {}) {
  const format = validateFile(file);
  if (typeof sanitize !== 'function') throw new ImportError('The document sanitizer is unavailable.');
  const filename = file.name.split(/[\\/]/).pop();
  const title = filename.replace(/\.[^.]+$/, '') || 'Reading space';
  let sourceSnapshot;
  let html;
  let warnings = [];
  if (format === 'pdf' || format === 'docx') {
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > MAX_FILE_BYTES) throw new ImportError('This file is larger than the 15 MB import limit.', 'file-too-large');
    sourceSnapshot = buffer.slice(0);
    const result = format === 'pdf' ? await parsePDF(buffer, onProgress) : await parseDOCX(buffer, onProgress);
    ({ html, warnings } = result);
  } else {
    onProgress?.('Reading document…');
    sourceSnapshot = await file.text();
    if (sourceSnapshot.length > MAX_TEXT_CHARACTERS) throw new ImportError('This document contains more text than the import limit.', 'file-too-large');
    if (format === 'html') html = sourceSnapshot;
    else if (format === 'markdown') {
      if (typeof markdownToHTML !== 'function') throw new ImportError('The Markdown parser is unavailable.');
      html = markdownToHTML(sourceSnapshot);
    } else html = sourceSnapshot.split(/\r?\n/).map((line) => `<p>${line ? escapeHTML(line) : '<br>'}</p>`).join('');
  }
  if (typeof html !== 'string' || html.length > MAX_OUTPUT_HTML_CHARACTERS) throw new ImportError('The converted document exceeds the import limit.', 'file-too-large');
  return { html: sanitize(html), format, sourceSnapshot, filename, title, warnings };
}
