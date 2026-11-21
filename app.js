import { generate, parseStructuredResponse } from './lib/ai.js';
import { findMatches } from './lib/search.js';
import { parseFile } from './lib/imports.js';
import { cleanHTML, markdownToHTML, looksLikeMarkdown } from './lib/document.js';
import { recoverySnapshot, recoverWorkspace } from './lib/recovery.js';

const DB_NAME = 'readmaxxin';
const DB_VERSION = 1;
const WORKSPACE_KEY = 'current';
const SETTINGS_KEY = 'settings';
const reader = document.querySelector('#reader');
const emptyHint = document.querySelector('#emptyHint');
const toolbar = document.querySelector('#selectionToolbar');
const explanation = document.querySelector('#explanation');
const explanationBody = document.querySelector('#explanationBody');
const selectionLabel = document.querySelector('#selectionLabel');
const $ = (selector) => document.querySelector(selector);
let db;
let saveTimer;
let scrollTimer;
let requestId = 0;
let activeController;
let capturedRequest;
let activeExplanationRequest;
let settings = { endpoint: '', model: '', provider: 'compatible', protocol: 'compatible', mode: 'local' };
let apiKey = '';
let searchMatches = [];
let currentMatch = -1;
let awaitingConnection = false;
const explanationStack = [];
let workspaceRevision = 0;
let workspaceReady = false;
let workspaceMeta = { title: 'Reading space', sourceFormat: 'plain', sourceSnapshot: '', filename: '' };
let readerRange;
let lastExplanation = '';
let connectionRequest;
let importRevision = 0;
let restoringSelection = false;
const highlightSupported = Boolean(globalThis.CSS?.highlights && globalThis.Highlight);
const proxyReady = fetch('/api/health', { signal: AbortSignal.timeout(2000) }).then(async (response) => response.ok && (await response.json()).ok === true).catch(() => false);

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('state')) database.createObjectStore('state');
    };
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Local storage is blocked by another tab.'));
  });
}

function readState(key) {
  return new Promise((resolve, reject) => {
    const request = db.transaction('state', 'readonly').objectStore('state').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function writeState(key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('state', 'readwrite');
    tx.objectStore('state').put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function stripSearchMarks() {
  reader.querySelectorAll('mark.search-hit').forEach((mark) => mark.replaceWith(document.createTextNode(mark.textContent)));
  reader.normalize();
}

function currentContent() {
  const copy = reader.cloneNode(true);
  copy.querySelectorAll('[data-math-source]').forEach((node) => node.replaceWith(document.createTextNode(node.dataset.mathSource)));
  copy.querySelectorAll('mark.search-hit').forEach((mark) => mark.replaceWith(document.createTextNode(mark.textContent)));
  copy.querySelectorAll('mark').forEach((mark) => mark.replaceWith(...mark.childNodes));
  return copy.innerHTML;
}

async function persistWorkspace() {
  if (!db) { if (workspaceReady) $('#saveStatus').textContent = 'Storage unavailable'; return; }
  const revision = workspaceRevision;
  const workspace = { ...workspaceMeta, schemaVersion: 2, contentHtml: currentContent(), scrollTop: window.scrollY, updatedAt: Date.now() };
  try { await writeState(WORKSPACE_KEY, workspace); if (revision === workspaceRevision) { $('#saveStatus').textContent = 'Saved locally'; try { const journal = JSON.parse(localStorage.getItem('readmaxxin-recovery') || 'null'); if (!journal || journal.updatedAt <= workspace.updatedAt) localStorage.removeItem('readmaxxin-recovery'); } catch { /* Recovery storage can be disabled independently. */ } } }
  catch { $('#saveStatus').textContent = 'Could not save'; }
}

function flushSave() {
  if (!workspaceReady && !workspaceRevision) return;
  clearTimeout(saveTimer); clearTimeout(scrollTimer);
  try {
    const journal = recoverySnapshot({ ...workspaceMeta, schemaVersion: 2, contentHtml: currentContent(), scrollTop: window.scrollY, updatedAt: Date.now() });
    if (journal) localStorage.setItem('readmaxxin-recovery', JSON.stringify(journal));
  } catch { /* IndexedDB remains the main storage if the small recovery journal is unavailable. */ }
  persistWorkspace();
}

function scheduleSave() {
  if (workspaceReady && !db) { $('#saveStatus').textContent = 'Storage unavailable'; return; }
  $('#saveStatus').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistWorkspace, 400);
}

function cancelExplanation(returnFocus = true) {
  const wasAwaitingConnection = awaitingConnection;
  requestId++;
  activeController?.abort();
  activeController = null;
  awaitingConnection = false;
  if (wasAwaitingConnection && $('#settingsDialog').open) $('#settingsDialog').close();
  explanationStack.length = 0;
  activeExplanationRequest = undefined;
  capturedRequest = undefined;
  lastExplanation = '';
  explanationBody.replaceChildren();
  $('#followupInput').value = '';
  $('#backExplanation').hidden = true;
  explanation.hidden = true;
  toolbar.hidden = true;
  if (returnFocus) restoreReaderFocus();
}

function restoreReaderFocus() {
  restoringSelection = true;
  const top = window.scrollY;
  reader.focus({ preventScroll: true });
  if (readerRange?.startContainer.isConnected && readerRange?.endContainer.isConnected) {
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(readerRange.cloneRange());
  }
  window.scrollTo(0, top);
  // Restoring native selection must not reopen the selection toolbar.
  setTimeout(() => { toolbar.hidden = true; restoringSelection = false; }, 50);
}

function setDocument(html, format, source = '', metadata = {}) {
  if (activeController || !explanation.hidden) cancelExplanation(false);
  toolbar.hidden = true;
  searchMatches = [];
  currentMatch = -1;
  if (highlightSupported) { CSS.highlights.delete('readmaxxin-search'); CSS.highlights.delete('readmaxxin-current'); }
  $('#searchHighlights').replaceChildren();
  stripSearchMarks();
  reader.innerHTML = cleanHTML(html);
  workspaceRevision++;
  capturedRequest = undefined;
  workspaceMeta = { title: metadata.title || 'Reading space', sourceFormat: format, sourceSnapshot: source, filename: metadata.filename || '', importedAt: Date.now() };
  readerRange = undefined;
  temporaryHighlights.length = 0;
  if (highlightSupported) CSS.highlights.delete('readmaxxin-notes');
  $('#clearHighlights').hidden = true;
  $('#formatLabel').textContent = format === 'plain' ? 'YOUR READING SPACE' : `${format.toUpperCase()} · YOUR READING SPACE`;
  emptyHint.hidden = reader.textContent.trim().length > 0;
  $('#documentTitle').textContent = workspaceMeta.filename || '';
  scheduleSave();
  renderReaderMath(workspaceRevision);
}

function restoreWorkspace(workspace) {
  if (!workspace) return;
  reader.innerHTML = cleanHTML(workspace.contentHtml || '');
  workspaceMeta = { title: workspace.title || 'Reading space', sourceFormat: workspace.sourceFormat || 'plain', sourceSnapshot: workspace.sourceSnapshot || '', filename: workspace.filename || '', importedAt: workspace.importedAt };
  $('#formatLabel').textContent = workspaceMeta.sourceFormat === 'plain' ? 'YOUR READING SPACE' : `${workspaceMeta.sourceFormat.toUpperCase()} · YOUR READING SPACE`;
  $('#documentTitle').textContent = workspaceMeta.filename;
  emptyHint.hidden = reader.textContent.trim().length > 0;
  requestAnimationFrame(() => { window.scrollTo(0, workspace.scrollTop || 0); });
  renderReaderMath(workspaceRevision).then(() => { if (!workspaceRevision) window.scrollTo(0, workspace.scrollTop || 0); });
}

function textGroups(root) {
  const groups = [];
  let current;
  const flush = () => { if (current?.text) groups.push(current); current = undefined; };
  const blocks = /^(P|DIV|H[1-6]|LI|BLOCKQUOTE|PRE|TD|TH|CAPTION)$/;
  function visit(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.textContent) return;
      current ||= { text: '', segments: [] };
      current.segments.push({ node, start: current.text.length, end: current.text.length + node.textContent.length });
      current.text += node.textContent;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.hasAttribute('data-math-source')) {
        current ||= { text: '', segments: [] };
        current.segments.push({ node, start: current.text.length, end: current.text.length + node.dataset.mathSource.length, atomic: true });
        current.text += node.dataset.mathSource; return;
      }
      if (node.tagName === 'BR') {
        if (node.parentElement === root) flush();
        else { current ||= { text: '', segments: [] }; current.segments.push({ node, start: current.text.length, end: current.text.length + 1, atomic: true }); current.text += '\n'; }
        return;
      }
      const block = node !== root && blocks.test(node.tagName);
      if (block) flush();
      for (const child of node.childNodes) visit(child);
      if (block) flush();
    }
  }
  visit(root); flush(); return groups;
}

function rangeFromOffsets(group, start, end) {
  const first = group.segments.find((segment) => segment.end > start);
  const last = group.segments.find((segment) => segment.end >= end);
  if (!first || !last) return null;
  const range = document.createRange();
  if (first.atomic) range.setStartBefore(first.node); else range.setStart(first.node, start - first.start);
  if (last.atomic) range.setEndAfter(last.node); else range.setEnd(last.node, end - last.start);
  return range;
}

function getContext(range, root) {
  let start = range.startContainer;
  if (start.nodeType !== Node.TEXT_NODE) {
    const child = start.childNodes[range.startOffset] || start;
    start = child.nodeType === Node.TEXT_NODE ? child : document.createTreeWalker(child, NodeFilter.SHOW_TEXT).nextNode();
  }
  const group = textGroups(root).find((group) => group.segments.some((segment) => segment.node === start || segment.atomic && segment.node.contains(start)));
  if (!group) return range.toString().trim();
  const segment = group.segments.find((segment) => segment.node === start || segment.atomic && segment.node.contains(start));
  const offset = segment.start + (range.startContainer === start ? range.startOffset : 0);
  // Bound oversized paragraphs around the selected term, never adjoining blocks.
  const from = Math.max(0, offset - 3000);
  return group.text.slice(from, Math.max(from + 6000, offset + range.toString().length)).trim();
}

function captureSelection() {
  const selection = document.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const root = reader.contains(range.startContainer) && reader.contains(range.endContainer) ? reader : explanationBody.contains(range.startContainer) && explanationBody.contains(range.endContainer) ? explanationBody : null;
  if (!root) return null;
  const text = selection.toString().trim();
  if (!text || text.length > 8000) return null;
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  if (root === reader) readerRange = range.cloneRange();
  return { selectedText: text, containingParagraph: getContext(range, root), rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height, bottom: rect.bottom }, fromExplanation: root === explanationBody };
}

function positionToolbar(request) {
  const width = Math.min(340, innerWidth - 20);
  toolbar.style.maxWidth = `${width}px`;
  toolbar.style.left = `${Math.max(10, Math.min(innerWidth - width - 10, request.rect.x))}px`;
  toolbar.style.top = `${Math.max(8, Math.min(innerHeight - 55, request.rect.y > 65 ? request.rect.y - 48 : request.rect.bottom + 8))}px`;
}

function showSelectionTools(autoExplainWord = false) {
  if (restoringSelection || $('#settingsDialog').open || $('#actionDialog').open) return;
  const request = captureSelection();
  if (!request) { toolbar.hidden = true; return; }
  capturedRequest = request;
  $('#highlightSelection').hidden = request.fromExplanation;
  selectionLabel.textContent = request.selectedText;
  positionToolbar(request);
  toolbar.hidden = false;
  if (autoExplainWord && request.selectedText.split(/\s+/).length === 1) explain('explain', '', request);
}

function positionExplanation(request) {
  if (innerWidth <= 760) { explanation.style.left = ''; explanation.style.right = ''; explanation.style.top = ''; explanation.style.maxHeight = ''; return; }
  const width = Math.min(360, innerWidth - 24);
  const rect = request.rect || { x: innerWidth / 2, y: 130, width: 0, bottom: 130 };
  const documentRect = reader.getBoundingClientRect();
  let left;
  if (innerWidth - documentRect.right >= width + 24) left = documentRect.right + 18;
  else if (documentRect.left >= width + 24) left = documentRect.left - width - 18;
  else left = rect.x + rect.width / 2 < innerWidth / 2 ? innerWidth - width - 16 : 16;
  let top = Math.max(78, Math.min(rect.y, innerHeight - 340));
  if (left < rect.x + rect.width && left + width > rect.x && top <= rect.bottom) top = Math.min(innerHeight - 250, rect.bottom + 16);
  top = Math.max(78, top);
  explanation.style.left = `${Math.max(12, left)}px`; explanation.style.right = 'auto'; explanation.style.top = `${top}px`; explanation.style.maxHeight = `${innerHeight - top - 16}px`;
}

function formatExplanation(data, raw, action = 'explain') {
  if (data && typeof data === 'object' && (data.technicalDefinition || data.definition || data.body)) {
    const headings = { explain: 'Technical definition', summary: 'Summary', simplify: 'Simplified explanation', example: 'Example', 'why-matters': 'Why it matters', 'first-principles': 'From first principles', prerequisites: 'Prerequisites', compare: 'Comparison', counterexample: 'Counterexample', critique: 'Claim assessment', translate: 'Translation', math: 'Mathematical explanation', 'fact-check': 'Model assessment', custom: 'Answer' };
    const definition = data.technicalDefinition || data.definition || data.body;
    let html = `<h3>${headings[action] || 'Explanation'}</h3><p class="definition">${escapeHTML(definition)}</p>`;
    if (action === 'explain' && data.contextualMeaning) html += `<h3>In this passage</h3><p>${escapeHTML(data.contextualMeaning)}</p>`;
    if (Array.isArray(data.prerequisites) && data.prerequisites.length) html += `<h3>Prerequisites</h3><div class="prerequisite-list">${data.prerequisites.slice(0, 3).map((term) => `<button type="button" class="prerequisite" data-term="${escapeHTML(term)}">${escapeHTML(term)}</button>`).join('')}</div>`;
    if (data.body && data.body !== definition) html += `<p>${escapeHTML(data.body)}</p>`;
    return html;
  }
  const headings = { explain: 'Explanation', summary: 'Summary', simplify: 'Simplified explanation', example: 'Example', 'why-matters': 'Why it matters', 'first-principles': 'From first principles', custom: 'Answer' };
  return `<h3>${headings[action] || 'Explanation'}</h3><p>${escapeHTML(raw || 'No explanation was returned.')}</p>`;
}

function escapeHTML(text) { return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }

function extractPartialDefinition(raw, field = 'technicalDefinition') {
  const match = raw.match(field === 'body' ? /"body"\s*:\s*"((?:\\.|[^"\\])*)/s : /"technicalDefinition"\s*:\s*"((?:\\.|[^"\\])*)/s);
  if (!match) return '';
  let escaped = match[1];
  if (escaped.endsWith('\\')) escaped = escaped.slice(0, -1);
  try { return JSON.parse(`"${escaped}"`); }
  catch { return escaped.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
}

function showStreamProgress(raw, action) {
  const definition = action === 'explain' ? extractPartialDefinition(raw) : extractPartialDefinition(raw, 'body') || extractPartialDefinition(raw);
  if (definition) explanationBody.innerHTML = formatExplanation({ technicalDefinition: definition, contextualMeaning: null, prerequisites: [] }, '', action);
  else if (!raw.trimStart().startsWith('{')) explanationBody.innerHTML = `<p>${escapeHTML(raw)}</p>`;
}

async function explain(action = 'explain', question = '', selectionRequest, { navigate = true } = {}) {
  const selected = selectionRequest || (action === 'explain' ? capturedRequest : activeExplanationRequest);
  if (!selected) return;
  const newConcept = navigate && (Boolean(selectionRequest) || action === 'explain');
  const previousContext = newConcept ? '' : lastExplanation;
  const previousNode = !explanation.hidden && activeExplanationRequest ? { term: $('#explanationTerm').textContent, body: explanationBody.innerHTML, request: { ...activeExplanationRequest }, explanationContext: lastExplanation } : null;
  if (newConcept) {
    if (selected.fromExplanation && previousNode) explanationStack.push(previousNode);
    else if (!selected.fromExplanation) explanationStack.length = 0;
    lastExplanation = '';
  }
  const current = { ...selected, fromExplanation: selected.fromExplanation, action, question, ...(action !== 'explain' ? { explanationContext: previousContext } : {}) };
  activeExplanationRequest = current;
  const id = ++requestId;
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  toolbar.hidden = true; explanation.hidden = false;
  $('#backExplanation').hidden = explanationStack.length === 0;
  $('#explanationTerm').textContent = action === 'summary' ? (current.selectedText.length > 1200 ? 'Document summary' : 'Selection summary') : current.selectedText;
  $('#explanationStatus').textContent = '';
  explanationBody.innerHTML = '<p class="busy" role="status">Thinking<span class="loading-dot"></span><span class="loading-dot"></span><span class="loading-dot"></span></p>';
  explanation.setAttribute('aria-busy', 'true');
  positionExplanation(current);
  if (!settings.endpoint || !settings.model) {
    explanation.setAttribute('aria-busy', 'false');
    explanationBody.innerHTML = '<p>Connect a model to explain this selection.</p>';
    connectionRequest = { action, question, selectionRequest: { ...selected } };
    awaitingConnection = true; activeController = null; openSettings(); return;
  }
  const timeout = setTimeout(() => controller.abort(new DOMException('The model took too long to respond. Try again or choose a smaller model.', 'TimeoutError')), 90000);
  const configuration = { ...settings, apiKey, signal: controller.signal, useProxy: await proxyReady };
  try {
    const raw = await generate(current, { ...configuration, onProgress: (raw) => { if (id === requestId) showStreamProgress(raw, action); } });
    if (id !== requestId) return;
    const data = parseStructuredResponse(raw);
    if (!data && /^(?:```json\s*)?\{/.test(raw.trim())) throw new Error('The model returned an incomplete explanation. Try again or choose another model.');
    lastExplanation = data || raw;
    explanationBody.innerHTML = formatExplanation(data, raw, action);
    await renderExplanationMath(id);
    if (id !== requestId) return;
    $('#explanationStatus').textContent = action === 'fact-check' ? 'Model assessment · no external sources checked' : '';
  } catch (error) {
    if (id !== requestId || error.name === 'AbortError') return;
    explanationBody.innerHTML = `<p class="error" role="alert">${escapeHTML(error.message || 'Unable to reach the model.')}</p><button class="button quiet" id="retryExplanation">Try again</button>`;
    $('#retryExplanation')?.addEventListener('click', () => explain(action, question, current, { navigate: false }));
  } finally {
    clearTimeout(timeout);
    if (id === requestId) { activeController = null; explanation.setAttribute('aria-busy', 'false'); }
  }
}

let mathModule;
let katexModule;
async function renderReaderMath(revision) {
  if (!/\$|\\\(|\\\[/.test(reader.textContent)) return;
  try {
    katexModule ||= import('/vendor/katex/katex.mjs');
    const { default: katex } = await katexModule;
    if (workspaceRevision !== revision) return;
    const walker = document.createTreeWalker(reader, NodeFilter.SHOW_TEXT, { acceptNode: (node) => node.parentElement.closest('pre,code,[data-math-source]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    const pattern = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^\n$]{1,500}\$/g;
    for (const node of nodes) {
      const matches = [...node.textContent.matchAll(pattern)]; if (!matches.length) continue;
      const fragment = document.createDocumentFragment(); let offset = 0;
      for (const match of matches) {
        fragment.append(node.textContent.slice(offset, match.index));
        const source = match[0]; const display = source.startsWith('$$') || source.startsWith('\\['); const size = source.startsWith('$') && !source.startsWith('$$') ? 1 : 2;
        const wrapper = document.createElement('span'); wrapper.dataset.mathSource = source; wrapper.contentEditable = 'false'; wrapper.tabIndex = 0; wrapper.className = 'reader-equation'; wrapper.title = 'Double-click to explain. Press F2 to edit the notation.'; wrapper.setAttribute('aria-label', `Equation ${source}. Press F2 to edit.`);
        katex.render(source.slice(size, -size), wrapper, { displayMode: display, throwOnError: false, trust: false, output: 'html' }); fragment.append(wrapper); offset = match.index + source.length;
      }
      fragment.append(node.textContent.slice(offset)); node.replaceWith(fragment);
    }
    if ($('#searchInput').value) updateSearch(false);
  } catch { /* Keep the editable source notation if optional rendering fails. */ }
}

async function renderExplanationMath(id) {
  try {
    mathModule ||= import('/vendor/katex/contrib/auto-render.mjs');
    const { default: renderMath } = await mathModule;
    if (id !== requestId) return;
    renderMath(explanationBody, { throwOnError: false, trust: false, delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }, { left: '\\(', right: '\\)', display: false }, { left: '\\[', right: '\\]', display: true }] });
  } catch { /* Plain notation stays readable if optional math assets are unavailable. */ }
}

function paintSearch() {
  if (highlightSupported) {
    CSS.highlights.delete('readmaxxin-search'); CSS.highlights.delete('readmaxxin-current');
    if (searchMatches.length) CSS.highlights.set('readmaxxin-search', new Highlight(...searchMatches));
    if (currentMatch >= 0 && searchMatches[currentMatch]) CSS.highlights.set('readmaxxin-current', new Highlight(searchMatches[currentMatch]));
  } else {
    const overlay = $('#searchHighlights'); overlay.replaceChildren();
    searchMatches.forEach((range, index) => {
      for (const rect of range.getClientRects()) {
        if (rect.bottom < 0 || rect.top > innerHeight) continue;
        const marker = document.createElement('span'); marker.className = index === currentMatch ? 'current' : '';
        Object.assign(marker.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }); overlay.append(marker);
      }
    });
  }
}

function updateSearch(scrollToFirst = true) {
  const previousIndex = currentMatch;
  searchMatches = []; currentMatch = -1;
  const query = $('#searchInput').value;
  if (query) {
    const groups = textGroups(reader);
    searchMatches = findMatches(groups, query).map((match) => rangeFromOffsets(groups[match.groupIndex], match.start, match.end)).filter(Boolean);
  }
  $('#prevMatch').disabled = $('#nextMatch').disabled = !searchMatches.length;
  if (!query) $('#matchCount').textContent = '';
  else if (!searchMatches.length) $('#matchCount').textContent = '0 matches';
  else {
    currentMatch = scrollToFirst ? 0 : Math.max(0, Math.min(previousIndex, searchMatches.length - 1));
    $('#matchCount').textContent = `${currentMatch + 1}/${searchMatches.length}`;
  }
  paintSearch();
  if (scrollToFirst && searchMatches.length) goToMatch(0);
}

function goToMatch(index) {
  if (!searchMatches.length) return;
  currentMatch = (index + searchMatches.length) % searchMatches.length;
  paintSearch();
  $('#matchCount').textContent = `${currentMatch + 1}/${searchMatches.length}`;
  const rect = searchMatches[currentMatch].getBoundingClientRect();
  window.scrollTo({ top: Math.max(0, window.scrollY + rect.top - innerHeight / 2), behavior: 'instant' });
}

function importText(text, format) {
  const html = format === 'html' ? cleanHTML(text) : format === 'markdown' ? markdownToHTML(text) : text.split(/\r?\n/).map((line) => line ? `<p>${escapeHTML(line)}</p>` : '<p><br></p>').join('');
  setDocument(html, format, text);
  window.scrollTo(0, 0);
  $('#searchInput').value = '';
  $('#matchCount').textContent = '';
}

function notify(message, error = false) {
  $('#noticeText').textContent = message; $('#notice').hidden = false; $('#notice').classList.toggle('notice-error', error);
}

function onDocumentInput() {
  workspaceRevision++;
  if (activeController || !explanation.hidden) cancelExplanation(false);
  emptyHint.hidden = reader.textContent.trim().length > 0;
  $('#summarizeDocument').hidden = !emptyHint.hidden;
  scheduleSave();
  if ($('#searchInput').value) updateSearch(false);
}

function insertPaste(event) {
  const html = event.clipboardData?.getData('text/html') || event.dataTransfer?.getData('text/html');
  const text = event.clipboardData?.getData('text/plain') || event.dataTransfer?.getData('text/plain');
  if (!text && !html) return;
  event.preventDefault();
  if ((html || text).length > 4 * 1024 * 1024) { notify('This paste is too large. Import a file up to 15 MB instead.', true); return; }
  const empty = !reader.textContent.trim();
  const markup = html ? cleanHTML(html) : looksLikeMarkdown(text) ? cleanHTML(markdownToHTML(text)) : null;
  if (empty) {
    workspaceMeta = { title: 'Reading space', sourceFormat: html ? 'html' : looksLikeMarkdown(text) ? 'markdown' : 'plain', sourceSnapshot: html || text, filename: '', importedAt: Date.now() };
    $('#formatLabel').textContent = workspaceMeta.sourceFormat === 'plain' ? 'YOUR READING SPACE' : `${workspaceMeta.sourceFormat.toUpperCase()} · YOUR READING SPACE`;
    $('#documentTitle').textContent = '';
  }
  if (markup !== null) document.execCommand('insertHTML', false, markup);
  else document.execCommand('insertText', false, text);
  onDocumentInput();
  renderReaderMath(workspaceRevision);
}

async function importFile(file) {
  if (!file) return;
  const token = ++importRevision;
  const revision = workspaceRevision;
  try {
    $('#openFile').disabled = true;
    const document = await parseFile(file, { sanitize: cleanHTML, markdownToHTML, onProgress: (text) => notify(text) });
    if (token !== importRevision) return;
    if (revision !== workspaceRevision) { notify('Your document changed while the file was opening. Open it again when you are ready to replace the reading space.', true); return; }
    setDocument(document.html, document.format, document.sourceSnapshot, document);
    clearTimeout(saveTimer); await persistWorkspace();
    $('#searchInput').value = ''; updateSearch(false); window.scrollTo(0, 0);
    $('#summarizeDocument').hidden = false;
    if (document.warnings.length) notify(document.warnings.join(' '));
    else $('#notice').hidden = true;
  } catch (error) { notify(error.message || 'This file could not be opened. The current reading space is still available.', true); }
  finally { $('#openFile').disabled = false; $('#fileInput').value = ''; }
}

reader.addEventListener('input', onDocumentInput);
reader.addEventListener('paste', insertPaste);
reader.addEventListener('dragover', (event) => event.preventDefault());
reader.addEventListener('drop', (event) => { event.preventDefault(); if (event.dataTransfer.files.length) importFile(event.dataTransfer.files[0]); else { reader.focus({ preventScroll: true }); insertPaste(event); } });
document.addEventListener('paste', (event) => {
  if (event.defaultPrevented || reader.contains(event.target) || $('#settingsDialog').open || $('#actionDialog').open || event.target.closest?.('input, textarea, select, button, [contenteditable="true"], #explanation')) return;
  const html = event.clipboardData.getData('text/html'); const text = event.clipboardData.getData('text/plain');
  if (!text && !html) return;
  event.preventDefault();
  if ((html || text).length > 4 * 1024 * 1024) { notify('This paste is too large. Import a file instead.', true); return; }
  importText(html || text, html ? 'html' : looksLikeMarkdown(text) ? 'markdown' : 'plain');
  $('#summarizeDocument').hidden = false;
});
function equationRequest(element) {
  const range = document.createRange(); range.selectNode(element); readerRange = range;
  const rect = element.getBoundingClientRect(); return { selectedText: element.dataset.mathSource, containingParagraph: getContext(range, reader), fromExplanation: false, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom } };
}
reader.addEventListener('dblclick', (event) => { const math = event.target.closest('[data-math-source]'); if (math) explain('explain', '', equationRequest(math)); else setTimeout(() => showSelectionTools(true), 0); });
reader.addEventListener('keydown', (event) => {
  const math = event.target.closest('[data-math-source]'); if (!math || event.key !== 'F2') return;
  event.preventDefault(); const text = document.createTextNode(math.dataset.mathSource); math.replaceWith(text); const range = document.createRange(); range.selectNodeContents(text); const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range); reader.focus({ preventScroll: true }); onDocumentInput();
});
explanationBody.addEventListener('dblclick', () => setTimeout(() => showSelectionTools(true), 0));
document.addEventListener('selectionchange', () => showSelectionTools(false));
$('#explainButton').addEventListener('mousedown', (event) => event.preventDefault());
toolbar.addEventListener('mousedown', (event) => { if (event.target.closest('button')) event.preventDefault(); });
$('#explainButton').addEventListener('click', () => explain('explain', '', capturedRequest));
$('#closeExplanation').addEventListener('click', () => cancelExplanation());
$('#backExplanation').addEventListener('click', () => {
  const previous = explanationStack.pop(); if (!previous) return;
  requestId++; activeController?.abort(); activeController = null;
  $('#explanationTerm').textContent = previous.term; explanationBody.innerHTML = previous.body;
  activeExplanationRequest = previous.request; capturedRequest = previous.request; lastExplanation = previous.explanationContext;
  explanation.setAttribute('aria-busy', 'false'); $('#backExplanation').hidden = !explanationStack.length; toolbar.hidden = true;
});
explanationBody.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-term]'); if (!chip || !activeExplanationRequest) return;
  const rect = chip.getBoundingClientRect();
  const request = { selectedText: chip.dataset.term, containingParagraph: explanationBody.innerText, fromExplanation: true, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom } };
  explain('explain', '', request);
});
$('#openFile').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (event) => importFile(event.target.files?.[0]));
$('#searchInput').addEventListener('input', () => updateSearch());
$('#searchInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); goToMatch(currentMatch + (event.shiftKey ? -1 : 1)); } });
$('#prevMatch').addEventListener('click', () => goToMatch(currentMatch - 1));
$('#nextMatch').addEventListener('click', () => goToMatch(currentMatch + 1));
window.addEventListener('scroll', () => { toolbar.hidden = true; if (!highlightSupported) paintSearch(); clearTimeout(scrollTimer); scrollTimer = setTimeout(scheduleSave, 200); }, { passive: true });
window.addEventListener('resize', () => { toolbar.hidden = true; if (activeExplanationRequest && !explanation.hidden) positionExplanation(activeExplanationRequest); if (!highlightSupported) paintSearch(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
window.addEventListener('pagehide', flushSave);
$('#focusButton').addEventListener('click', async () => {
  const entering = !document.body.classList.contains('focus-mode'); document.body.classList.toggle('focus-mode', entering); $('#focusButton').setAttribute('aria-pressed', String(entering));
  if (entering && document.fullscreenEnabled && !document.fullscreenElement) await document.documentElement.requestFullscreen().catch(() => {});
  else if (!entering && document.fullscreenElement) await document.exitFullscreen().catch(() => {});
});
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) { document.body.classList.remove('focus-mode'); $('#focusButton').setAttribute('aria-pressed', 'false'); } });

function defaultEndpoint(mode, protocol = 'compatible') { return protocol === 'ollama' ? 'http://localhost:11434/api/chat' : mode === 'cloud' ? 'https://api.openai.com/v1/chat/completions' : 'http://localhost:1234/v1/chat/completions'; }
function inferProviderMode(endpoint) {
  try { const { hostname } = new URL(endpoint); return /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(hostname) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname) || hostname.endsWith('.local') ? 'local' : 'cloud'; }
  catch { return 'local'; }
}
function normalizeEndpoint(value, protocol) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Use an HTTP or HTTPS endpoint without credentials in the address.');
  if (['/', '/v1', '/v1/'].includes(url.pathname)) url.pathname = protocol === 'ollama' ? '/api/chat' : '/v1/chat/completions';
  return url.href;
}
const sessionKeys = { local: '', cloud: '' };
let drafts;
let draftKeys;
let draftMode;
let connectionController;
function readConnectionForm() { return { endpoint: $('#endpointInput').value.trim(), model: $('#modelInput').value.trim(), protocol: $('#protocolInput').value }; }
function loadConnectionForm(mode) {
  draftMode = mode; const profile = drafts[mode];
  $('#endpointInput').value = profile.endpoint || defaultEndpoint(mode, profile.protocol); $('#endpointInput').placeholder = defaultEndpoint(mode, profile.protocol);
  $('#modelInput').value = profile.model || ''; $('#protocolInput').value = profile.protocol || 'compatible'; $('#keyInput').value = draftKeys[mode] || '';
  document.querySelector(`input[name="providerMode"][value="${mode}"]`).checked = true;
  $('#connectionStatus').textContent = ''; $('#availableModels').replaceChildren();
}
function updateAIStatus() { $('#aiStatus').textContent = settings.model ? `${settings.mode === 'cloud' ? 'Cloud' : 'Local'} · ${settings.model}` : 'Connect AI'; }
function openSettings() {
  if ($('#settingsDialog').open) return;
  drafts = structuredClone(settings.connections || { local: { endpoint: '', model: '', protocol: 'compatible' }, cloud: { endpoint: '', model: '', protocol: 'compatible' } });
  drafts[settings.mode] = { endpoint: settings.endpoint, model: settings.model, protocol: settings.protocol || 'compatible' };
  draftKeys = { ...sessionKeys }; draftKeys[settings.mode] = apiKey;
  loadConnectionForm(settings.mode); $('#settingsDialog').showModal();
}
function closeSettings() { connectionController?.abort(); connectionController = undefined; $('#testConnection').disabled = false; awaitingConnection = false; connectionRequest = undefined; $('#settingsDialog').close(); }
$('#settingsButton').addEventListener('click', openSettings); $('#aiStatus').addEventListener('click', openSettings);
document.querySelectorAll('[data-close-settings]').forEach((button) => button.addEventListener('click', closeSettings));
document.querySelectorAll('input[name="providerMode"]').forEach((radio) => radio.addEventListener('change', () => {
  if (!radio.checked) return;
  connectionController?.abort(); connectionController = undefined; $('#testConnection').disabled = false; drafts[draftMode] = readConnectionForm(); draftKeys[draftMode] = $('#keyInput').value; loadConnectionForm(radio.value);
}));
$('#protocolInput').addEventListener('change', () => { const value = $('#endpointInput').value; if (!value || /localhost:(1234|11434)/.test(value)) $('#endpointInput').value = defaultEndpoint(draftMode, $('#protocolInput').value); });
$('#testConnection').addEventListener('click', async () => {
  connectionController?.abort(); connectionController = new AbortController(); const controller = connectionController; const timer = setTimeout(() => controller.abort(), 10000);
  $('#connectionStatus').textContent = 'Checking connection…'; $('#testConnection').disabled = true;
  try {
    const profile = readConnectionForm(); profile.endpoint = normalizeEndpoint(profile.endpoint, profile.protocol);
    const useProxy = await proxyReady; let response;
    if (useProxy) response = await fetch('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...profile, apiKey: $('#keyInput').value }), signal: controller.signal });
    else {
      const url = new URL(profile.endpoint); url.pathname = profile.protocol === 'ollama' ? '/api/tags' : url.pathname.replace(/\/chat\/completions\/?$/, '/models');
      response = await fetch(url, { headers: $('#keyInput').value ? { Authorization: `Bearer ${$('#keyInput').value}` } : {}, signal: controller.signal });
    }
    const payload = await response.json(); if (!response.ok) throw new Error(payload.error || `The model server returned ${response.status}.`);
    const models = payload.models?.map((item) => typeof item === 'string' ? item : item.name) || payload.data?.map((item) => item.id) || [];
    $('#availableModels').replaceChildren(...models.map((model) => { const option = document.createElement('option'); option.value = model; return option; }));
    if (!$('#modelInput').value && models.length === 1) $('#modelInput').value = models[0];
    $('#connectionStatus').textContent = models.length ? `Connected · ${models.length} model${models.length === 1 ? '' : 's'} available. Choose a model below.` : 'Server reached. Enter the model name manually.';
  } catch (error) { if (connectionController === controller) $('#connectionStatus').textContent = controller.signal.aborted ? 'Connection check cancelled or timed out.' : error.message || 'Could not connect. Start the app with npm start to use the local connector.'; }
  finally { clearTimeout(timer); if (connectionController === controller) $('#testConnection').disabled = false; }
});
$('#settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const profile = readConnectionForm(); profile.endpoint = normalizeEndpoint(profile.endpoint, profile.protocol); drafts[draftMode] = profile; draftKeys[draftMode] = $('#keyInput').value;
    requestId++; activeController?.abort(); activeController = null;
    settings = { ...profile, provider: 'compatible', mode: draftMode, connections: structuredClone(drafts) }; Object.assign(sessionKeys, draftKeys); apiKey = draftKeys[draftMode]; updateAIStatus();
    if (db) await writeState(SETTINGS_KEY, settings);
    $('#settingsDialog').close();
    const pending = connectionRequest; connectionRequest = undefined;
    if (awaitingConnection && pending) { awaitingConnection = false; explain(pending.action, pending.question, pending.selectionRequest, { navigate: false }); }
    else if (!explanation.hidden && activeExplanationRequest) { explanation.setAttribute('aria-busy', 'false'); $('#explanationStatus').textContent = 'AI connection changed. Choose an action to continue.'; }
  } catch (error) { $('#connectionStatus').textContent = error.message || 'Could not save settings.'; }
});
$('#settingsDialog').addEventListener('cancel', () => { connectionController?.abort(); awaitingConnection = false; connectionRequest = undefined; });

let pendingAction;
function runAction(action) {
  if (['compare', 'translate'].includes(action)) { pendingAction = action; $('#actionTitle').textContent = action === 'compare' ? 'Compare with another concept' : 'Translate the selection'; $('#actionQuestion').value = ''; $('#actionQuestion').placeholder = action === 'compare' ? 'Concept to compare with' : 'Target language'; $('#actionDialog').showModal(); }
  else explain(action);
  $('#moreActions').open = false;
}
document.querySelectorAll('.explanation-actions [data-action], .more-actions [data-action]').forEach((button) => button.addEventListener('click', () => runAction(button.dataset.action)));
$('#actionForm').addEventListener('submit', (event) => { event.preventDefault(); const value = $('#actionQuestion').value.trim(); if (!value) return; $('#actionDialog').close(); explain(pendingAction, value); });
document.querySelectorAll('[data-close-action]').forEach((button) => button.addEventListener('click', () => $('#actionDialog').close()));
$('#followupForm').addEventListener('submit', (event) => { event.preventDefault(); const question = $('#followupInput').value.trim(); if (!question || !activeExplanationRequest) return; $('#followupInput').value = ''; explain('custom', question); });
$('#summarizeDocument').addEventListener('click', () => {
  const text = textGroups(reader).map((group) => group.text).join('\n\n').trim(); if (!text) return;
  if (text.length > 60000) { notify('Select a section to summarize. This document is too long for one compact request.', true); return; }
  explain('summary', '', { selectedText: text, containingParagraph: '', fromExplanation: false, rect: { x: innerWidth / 2, y: 130, bottom: 150, width: 0 } });
});
$('#summarizeSelection').addEventListener('click', () => { if (capturedRequest) explain('summary', '', capturedRequest); });
$('#dismissNotice').addEventListener('click', () => { $('#notice').hidden = true; });

const temporaryHighlights = [];
$('#highlightSelection').addEventListener('mousedown', (event) => event.preventDefault());
$('#highlightSelection').addEventListener('click', () => {
  if (!readerRange || capturedRequest?.fromExplanation) return;
  if (!highlightSupported) { notify('Temporary highlighting needs a browser with the Custom Highlight API, such as a current Chrome, Edge, Firefox, or Safari.', true); return; }
  temporaryHighlights.push(readerRange.cloneRange()); CSS.highlights.set('readmaxxin-notes', new Highlight(...temporaryHighlights));
  $('#clearHighlights').hidden = false; toolbar.hidden = true;
});
$('#clearHighlights').addEventListener('click', () => { temporaryHighlights.length = 0; if (highlightSupported) CSS.highlights.delete('readmaxxin-notes'); $('#clearHighlights').hidden = true; });
document.addEventListener('keydown', (event) => {
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === 'f' && !$('#settingsDialog').open && !$('#actionDialog').open) { event.preventDefault(); $('#searchInput').focus(); $('#searchInput').select(); }
  if (mod && event.shiftKey && event.key.toLowerCase() === 'e' && !$('#settingsDialog').open && !$('#actionDialog').open) { event.preventDefault(); const math = document.activeElement.closest?.('[data-math-source]'); const request = math ? equationRequest(math) : captureSelection(); if (request) explain('explain', '', request); }
  if (event.key === 'Escape') {
    if ($('#settingsDialog').open || $('#actionDialog').open) return;
    if (!explanation.hidden) { event.preventDefault(); cancelExplanation(); }
    else if (!toolbar.hidden) { toolbar.hidden = true; restoreReaderFocus(); }
    else if (document.body.classList.contains('focus-mode')) { document.body.classList.remove('focus-mode'); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
    else if (document.activeElement === $('#searchInput')) { $('#searchInput').value = ''; updateSearch(false); restoreReaderFocus(); }
  }
});
document.addEventListener('pointerdown', (event) => {
  if (!toolbar.hidden && !toolbar.contains(event.target) && !reader.contains(event.target) && !explanation.contains(event.target)) toolbar.hidden = true;
  if (!explanation.hidden && !explanation.contains(event.target) && !toolbar.contains(event.target) && !$('#settingsDialog').open && !$('#actionDialog').open && !event.target.closest('.topbar,dialog')) cancelExplanation(false);
});

try {
  $('#saveStatus').textContent = 'Restoring…'; db = await openDatabase();
  const saved = await readState(WORKSPACE_KEY);
  let journal; try { journal = JSON.parse(localStorage.getItem('readmaxxin-recovery') || 'null'); } catch { /* No recovery record available. */ }
  const workspace = recoverWorkspace(saved, journal);
  if (!workspaceRevision) restoreWorkspace(workspace); else scheduleSave();
  const stored = await readState(SETTINGS_KEY);
  if (stored) { settings = { ...settings, ...stored }; if (!stored.mode) settings.mode = inferProviderMode(stored.endpoint); }
  $('#saveStatus').textContent = 'Saved locally';
} catch { $('#saveStatus').textContent = 'Local storage unavailable'; notify('Browser storage is unavailable. You can read and edit, but changes will not restore after closing.', true); }
workspaceReady = true;
updateAIStatus();
$('#summarizeDocument').hidden = !reader.textContent.trim();
$('#prevMatch').disabled = $('#nextMatch').disabled = true;
try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* Native browser defaults remain available. */ }
if (!/Mac|iPhone|iPad/.test(navigator.platform)) document.querySelectorAll('kbd').forEach((key) => { key.textContent = key.textContent.replaceAll('⌘', 'Ctrl').replaceAll('⇧', 'Shift'); });
