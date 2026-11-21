const ALLOWED_TAGS = new Set(['P', 'DIV', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'PRE', 'CODE', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'INS', 'SUB', 'SUP', 'A', 'TABLE', 'CAPTION', 'COLGROUP', 'COL', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'HR', 'MARK', 'IMG', 'FIGURE', 'FIGCAPTION']);
const DROP_SUBTREES = 'script,style,iframe,object,embed,form,input,button,textarea,select,option,link,meta,base,svg,math,template,audio,video,source,track,canvas,noscript,frame,frameset,applet,title,head';
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const MAX_IMAGE_DATA_CHARACTERS = 3 * 1024 * 1024;

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function safeLink(value) {
  if (!value || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return '';
  try {
    const parsed = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? parsed.href : '';
  } catch { return ''; }
}

function safeImage(value) {
  return typeof value === 'string' && value.length <= MAX_IMAGE_DATA_CHARACTERS && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/]+={0,2}$/i.test(value) ? value : '';
}

/**
 * Keep readable semantic HTML while removing executable content and resource
 * loads. HTML is first parsed in an inert template, so even a hostile image or
 * iframe cannot fetch an external URL before its attributes are removed.
 * The optional document injection is useful for isolated non-browser tests.
 */
export function cleanHTML(html, { document: doc = globalThis.document } = {}) {
  if (!doc?.createElement) throw new Error('HTML sanitization requires a document parser.');
  const template = doc.createElement('template');
  template.innerHTML = String(html ?? '');
  const root = template.content;
  root.querySelectorAll(DROP_SUBTREES).forEach((node) => node.remove());
  for (const node of root.querySelectorAll('*')) {
    if (!ALLOWED_TAGS.has(node.tagName) || (node.namespaceURI && node.namespaceURI !== HTML_NAMESPACE)) {
      node.replaceWith(...node.childNodes);
      continue;
    }
    const tag = node.tagName;
    const href = tag === 'A' ? safeLink((node.getAttribute('href') || '').trim()) : '';
    const src = tag === 'IMG' ? safeImage(node.getAttribute('src')) : '';
    const alt = tag === 'IMG' ? (node.getAttribute('alt') || '').slice(0, 1000) : '';
    const spans = {};
    if (['TD', 'TH', 'COL', 'COLGROUP'].includes(tag)) {
      for (const attr of ['colspan', 'rowspan', 'span']) {
        const value = node.getAttribute(attr);
        if (value && /^\d{1,3}$/.test(value) && Number(value) >= 1 && Number(value) <= 100 && ((['TD', 'TH'].includes(tag) && attr !== 'span') || (['COL', 'COLGROUP'].includes(tag) && attr === 'span'))) spans[attr] = String(Number(value));
      }
    }
    const listStart = tag === 'OL' && /^\d{1,6}$/.test(node.getAttribute('start') || '') ? node.getAttribute('start') : '';
    for (const attr of [...node.attributes]) node.removeAttribute(attr.name);
    for (const [name, value] of Object.entries(spans)) node.setAttribute(name, value);
    if (listStart) node.setAttribute('start', listStart);
    if (tag === 'A' && href) { node.setAttribute('href', href); node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
    if (tag === 'IMG') {
      if (!src) { node.replaceWith(doc.createTextNode(alt || '[External or unsupported image omitted]')); continue; }
      node.setAttribute('src', src);
      node.setAttribute('alt', alt);
      node.setAttribute('decoding', 'async');
    }
  }
  const output = doc.createElement('div');
  output.append(root.cloneNode(true));
  return output.innerHTML;
}

function backtickEnd(text, start, count) {
  for (let index = start; index < text.length;) {
    if (text[index] !== '`') { index++; continue; }
    let end = index;
    while (text[end] === '`') end++;
    if (end - index === count) return index;
    index = end;
  }
  return -1;
}

function closingDelimiter(text, marker, start) {
  for (let index = start; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === '`') {
      let count = 1;
      while (text[index + count] === '`') count++;
      const end = backtickEnd(text, index + count, count);
      if (end >= 0) { index = end + count - 1; continue; }
    }
    if (text.startsWith(marker, index) && !/\s/.test(text[index - 1] || '')) return index;
  }
  return -1;
}

function inlineMarkdown(text, depth = 0, allowLinks = true) {
  if (depth > 12) return escapeHTML(text);
  let html = '';
  let nextLabelEnd = allowLinks ? text.indexOf('](') : -1;
  const parsedTargets = new Map();
  for (let index = 0; index < text.length;) {
    if (text[index] === '\\' && ['(', '['].includes(text[index + 1])) {
      const closing = text[index + 1] === '(' ? '\\)' : '\\]';
      const end = text.indexOf(closing, index + 2);
      if (end >= 0) { html += escapeHTML(text.slice(index, end + 2)); index = end + 2; continue; }
    }
    if (text[index] === '\n') {
      let slashes = 0;
      for (let before = index - 1; before >= 0 && text[before] === '\\'; before--) slashes++;
      if (text[index - 1] === ' ' && text[index - 2] === ' ') html = html.replace(/ {2,}$/, '') + '<br>';
      else if (slashes % 2) html = html.slice(0, -1) + '<br>';
      else html += ' ';
      index++;
      continue;
    }
    if (text[index] === '\\' && /[\\`*_{}\[\]()#+.!|>~-]/.test(text[index + 1] || '')) { html += escapeHTML(text[index + 1]); index += 2; continue; }
    if (text[index] === '`') {
      let count = 1;
      while (text[index + count] === '`') count++;
      const end = backtickEnd(text, index + count, count);
      if (end >= 0) {
        let code = text.slice(index + count, end).replace(/\r?\n/g, ' ');
        if (/^ .* $/.test(code) && /\S/.test(code)) code = code.slice(1, -1);
        html += `<code>${escapeHTML(code)}</code>`;
        index = end + count;
        continue;
      }
      html += escapeHTML(text.slice(index, index + count)); index += count; continue;
    }
    if (allowLinks && text[index] === '[') {
      while (nextLabelEnd >= 0 && nextLabelEnd <= index) nextLabelEnd = text.indexOf('](', nextLabelEnd + 2);
      const labelEnd = nextLabelEnd;
      if (labelEnd >= 0) {
        if (!parsedTargets.has(labelEnd)) {
          let nesting = 1;
          let end = labelEnd + 2;
          const limit = Math.min(text.length, end + 4097);
          for (; end < limit; end++) {
            if (text[end] === '\\') { end++; continue; }
            if (text[end] === '(') nesting++;
            else if (text[end] === ')') { nesting--; if (!nesting) break; }
          }
          const href = nesting === 0 ? safeLink(text.slice(labelEnd + 2, end).trim()) : '';
          parsedTargets.set(labelEnd, href ? { href, end } : null);
        }
        // Count balanced parentheses without interpreting URL or label content as HTML.
        const target = parsedTargets.get(labelEnd);
        if (target) {
          html += `<a href="${escapeHTML(target.href)}">${inlineMarkdown(text.slice(index + 1, labelEnd), depth + 1, false)}</a>`;
          index = target.end + 1;
          continue;
        }
      }
    }
    const char = text[index];
    if ((char === '*' || char === '_') && !/\s/.test(text[index + 1] || '') && !(char === '_' && /[\p{L}\p{N}]/u.test(text[index - 1] || ''))) {
      const marker = text.startsWith(char.repeat(3), index) ? char.repeat(3) : text.startsWith(char.repeat(2), index) ? char.repeat(2) : char;
      const end = closingDelimiter(text, marker, index + marker.length);
      if (end > index + marker.length) {
        const content = inlineMarkdown(text.slice(index + marker.length, end), depth + 1, allowLinks);
        html += marker.length === 3 ? `<strong><em>${content}</em></strong>` : marker.length === 2 ? `<strong>${content}</strong>` : `<em>${content}</em>`;
        index = end + marker.length;
        continue;
      }
    }
    html += escapeHTML(char);
    index++;
  }
  return html;
}

function tableCells(line) {
  const cells = [];
  let cell = '';
  let codeTicks = 0;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '\\' && index + 1 < line.length) { cell += line[index] + line[++index]; continue; }
    if (line[index] === '`') {
      let count = 1;
      while (line[index + count] === '`') count++;
      if (!codeTicks) codeTicks = count;
      else if (codeTicks === count) codeTicks = 0;
      cell += '`'.repeat(count); index += count - 1; continue;
    }
    if (line[index] === '|' && !codeTicks) { cells.push(cell.trim()); cell = ''; }
    else cell += line[index];
  }
  cells.push(cell.trim());
  if (cells[0] === '') cells.shift();
  if (cells.at(-1) === '') cells.pop();
  return cells;
}

/** A compact reading-oriented Markdown renderer; source text is never mutated. */
export function markdownToHTML(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = [];
  let listType = '';
  let fence;
  let codeLines = [];
  let paragraph = [];
  let quote = [];
  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${inlineMarkdown(paragraph.join('\n'))}</p>`);
    paragraph = [];
  };
  const flushQuote = () => { if (quote.length) out.push(`<blockquote><p>${quote.map((line) => inlineMarkdown(line)).join('<br>')}</p></blockquote>`); quote = []; };
  const closeList = () => { if (listType) out.push(`</${listType}>`); listType = ''; };
  const flushBlocks = () => { flushParagraph(); closeList(); flushQuote(); };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (fence) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) { out.push(`<pre><code>${escapeHTML(codeLines.join('\n'))}</code></pre>`); fence = undefined; codeLines = []; }
      else codeLines.push(line);
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening) { flushBlocks(); fence = { char: opening[1][0], length: opening[1].length }; continue; }
    if (!line.trim()) { flushBlocks(); continue; }
    const separator = tableCells(lines[index + 1] || '');
    if (line.includes('|') && separator.length && separator.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      flushBlocks();
      const header = tableCells(line);
      const rows = [];
      index++;
      while (index + 1 < lines.length && lines[index + 1].includes('|') && lines[index + 1].trim()) rows.push(tableCells(lines[++index]));
      const width = Math.max(header.length, ...rows.map((row) => row.length));
      out.push(`<table><thead><tr>${Array.from({ length: width }, (_, column) => `<th>${inlineMarkdown(header[column] || '')}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${Array.from({ length: width }, (_, column) => `<td>${inlineMarkdown(row[column] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) { flushBlocks(); out.push('<hr>'); continue; }
    const heading = line.match(/^ {0,3}(#{1,6})(?:\s+|$)(.*)$/);
    const list = line.match(/^\s*([-*+]\s+|\d+[.)]\s+)(.*)$/);
    const quoteLine = line.match(/^ {0,3}>\s?(.*)$/);
    if (heading) { flushBlocks(); const level = heading[1].length; out.push(`<h${level}>${inlineMarkdown(heading[2].replace(/\s+#+\s*$/, ''))}</h${level}>`); continue; }
    if (list) { flushParagraph(); flushQuote(); const type = /^\s*\d/.test(line) ? 'ol' : 'ul'; if (listType !== type) { closeList(); listType = type; const start = type === 'ol' ? parseInt(list[1], 10) : 1; out.push(type === 'ol' && start !== 1 ? `<ol start="${start}">` : `<${type}>`); } out.push(`<li>${inlineMarkdown(list[2])}</li>`); continue; }
    if (quoteLine) { flushParagraph(); closeList(); quote.push(quoteLine[1]); continue; }
    flushQuote(); closeList(); paragraph.push(line);
  }
  flushBlocks();
  if (fence) out.push(`<pre><code>${escapeHTML(codeLines.join('\n'))}</code></pre>`);
  return out.join('');
}

export function looksLikeMarkdown(text) {
  const source = String(text ?? '');
  const block = /^( {0,3}#{1,6}(?:\s|$)|\s*[-*+]\s+|\s*\d+[.)]\s+| {0,3}(?:`{3,}|~{3,})| {0,3}>(?:\s|$)|\s*\|.*\|\s*$| {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$)/m;
  const explicitInline = /(?:\*\*(?=\S)[^\n]+?\*\*|__(?=\S)[^\n]+?__|(`{1,3})[^`\n]+?\1|\[[^\]\n]+\]\(https?:\/\/[^\s]+\)|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\])/;
  return block.test(source) || explicitInline.test(source);
}
