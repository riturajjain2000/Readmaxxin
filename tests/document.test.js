import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { cleanHTML, markdownToHTML, looksLikeMarkdown } from '../lib/document.js';

function documentForTests() { return parseHTML('<!doctype html><html><body></body></html>').document; }
function sanitize(html) { return cleanHTML(html, { document: documentForTests() }); }
function fragment(html) {
  const document = documentForTests();
  const template = document.createElement('template');
  template.innerHTML = html;
  const container = document.createElement('div');
  container.append(template.content.cloneNode(true));
  return container;
}

test('drops dangerous subtrees and their contents rather than exposing script/style text', () => {
  const html = sanitize('<p>Readable</p><script>stealKey()</script><style>body{display:none}</style><iframe src="https://bad.example/"><p>Hidden</p></iframe><svg><script>svgAttack()</script><text>SVG text</text></svg><math><mi>x</mi></math><template><p>Template text</p></template>');
  assert.equal(fragment(html).textContent, 'Readable');
  assert.equal(fragment(html).querySelectorAll('script,style,iframe,svg,math,template').length, 0);
});

test('strips event handlers, CSS, document IDs, unsafe links, and image resource attributes', () => {
  const html = sanitize('<div id="settingsDialog" style="position:fixed" onclick="attack()"><a href="javascript:attack()" onmouseover="attack()">Unsafe</a><a href="data:text/html,attack">Data link</a><img src="https://bad.example/track" srcset="https://bad.example/2x 2x" onerror="attack()" alt="Diagram"></div>');
  const root = fragment(html);
  for (const node of root.querySelectorAll('*')) {
    assert.equal([...node.attributes].some((attribute) => /^(?:on|style$|id$|srcset$)/i.test(attribute.name)), false);
  }
  assert.equal(root.querySelectorAll('a[href]').length, 0);
  assert.equal(root.querySelectorAll('img').length, 0);
  assert.match(root.textContent, /Diagram/);
  assert.doesNotMatch(html, /bad\.example/);
});

test('preserves safe reading semantics including table spans and subscript/superscript', () => {
  const html = sanitize('<h2>Formula</h2><p><strong>Water</strong> H<sub>2</sub>O and x<sup>2</sup> with <em>emphasis</em>.</p><table><caption>Data</caption><tbody><tr><th colspan="2">Group</th></tr><tr><td rowspan="2">A</td><td>B</td></tr></tbody></table><ol start="4"><li>Fourth</li></ol>');
  const root = fragment(html);
  assert.equal(root.querySelector('h2').textContent, 'Formula');
  assert.equal(root.querySelector('sub').textContent, '2');
  assert.equal(root.querySelector('sup').textContent, '2');
  assert.equal(root.querySelector('th').getAttribute('colspan'), '2');
  assert.equal(root.querySelector('td').getAttribute('rowspan'), '2');
  assert.equal(root.querySelector('caption').textContent, 'Data');
  assert.equal(root.querySelector('ol').getAttribute('start'), '4');
});

test('retains safe links and raster data images while removing SVG and external images', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const html = sanitize(`<a href="https://example.com/reading?q=1&amp;x=2">Source</a><img src="${png}" alt="Inline figure"><img src="data:image/svg+xml;base64,PHN2Zy8+" alt="SVG omitted"><img src="//bad.example/x" alt="External omitted">`);
  const root = fragment(html);
  const link = root.querySelector('a');
  assert.equal(link.getAttribute('href'), 'https://example.com/reading?q=1&x=2');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(root.querySelectorAll('img').length, 1);
  assert.equal(root.querySelector('img').getAttribute('src'), png);
  assert.match(root.textContent, /SVG omittedExternal omitted/);
});

test('sanitization remains stable when restoring already-sanitized workspace content', () => {
  const once = sanitize('<section><h1>Title</h1><p><span style="color:red">Text</span> <a href="mailto:reader@example.com">Mail</a></p></section>');
  assert.equal(sanitize(once), once);
});

test('inline code protects literal Markdown characters and escapes source HTML', () => {
  const root = fragment(markdownToHTML('Use `**literal** [x](https://example.com) <tag>` and **normal bold**.'));
  assert.equal(root.querySelector('code').textContent, '**literal** [x](https://example.com) <tag>');
  assert.equal(root.querySelector('code strong'), null);
  assert.equal(root.querySelector('code a'), null);
  assert.equal(root.querySelector('strong').textContent, 'normal bold');
  assert.equal(root.querySelector('tag'), null);
});

test('emphasis may contain code without interpreting delimiters inside that code', () => {
  const root = fragment(markdownToHTML('**Use `a*b` carefully** and `` `quoted` ``.'));
  assert.equal(root.querySelector('strong').textContent, 'Use a*b carefully');
  assert.equal(root.querySelectorAll('code')[0].textContent, 'a*b');
  assert.equal(root.querySelectorAll('code')[1].textContent, '`quoted`');
});

test('fenced code stays literal and preserves line breaks and HTML characters', () => {
  const source = '```html\n<script>run()</script>\n**literal**\n```';
  const root = fragment(markdownToHTML(source));
  assert.equal(root.querySelector('pre code').textContent, '<script>run()</script>\n**literal**');
  assert.equal(root.querySelectorAll('script,strong').length, 0);
});

test('renders headings and tables with escaped pipes and code pipes intact', () => {
  const source = '###### Heading\n\n| Name | Value |\n| --- | --- |\n| a\\|b | `x|y` |';
  const root = fragment(markdownToHTML(source));
  assert.equal(root.querySelector('h6').textContent, 'Heading');
  assert.deepEqual([...root.querySelectorAll('th')].map((cell) => cell.textContent), ['Name', 'Value']);
  assert.deepEqual([...root.querySelectorAll('td')].map((cell) => cell.textContent), ['a|b', 'x|y']);
  assert.equal(root.querySelector('td code').textContent, 'x|y');
});

test('renders safe Markdown links including balanced URL parentheses', () => {
  const root = fragment(markdownToHTML('[Source](https://example.com/a(b)) and [unsafe](javascript:run()) <img src=x onerror=run()>'));
  assert.equal(root.querySelectorAll('a').length, 1);
  assert.equal(root.querySelector('a').getAttribute('href'), 'https://example.com/a(b)');
  assert.equal(root.querySelectorAll('img').length, 0);
  assert.match(root.textContent, /\[unsafe\]\(javascript:run\(\)\)/);
});

test('preserves ordered starts, quote lines, and Markdown hard breaks', () => {
  const root = fragment(markdownToHTML('4. Fourth\n5. Fifth\n\n> Quote\n> continuation\n\nFirst  \nSecond'));
  assert.equal(root.querySelector('ol').getAttribute('start'), '4');
  assert.equal(root.querySelectorAll('li').length, 2);
  assert.equal(root.querySelectorAll('blockquote br').length, 1);
  assert.equal(root.querySelectorAll('p').at(-1).querySelectorAll('br').length, 1);
});

test('recognizes reading-oriented Markdown block patterns without treating plain text as Markdown', () => {
  for (const source of ['# Heading', '###### Heading', '- List', '1. List', '> Quote', '~~~js\ncode\n~~~', '| A | B |\n| --- | --- |', '---']) assert.equal(looksLikeMarkdown(source), true);
  assert.equal(looksLikeMarkdown('An ordinary paragraph about reading.'), false);
});

test('preserves matched LaTeX delimiters and commands for the math renderer', () => {
  const inline = 'A sum \\(\\sum_{i=1}^{n} x_i * y_i\\) and **ordinary bold**.';
  const root = fragment(markdownToHTML(inline));
  assert.match(root.textContent, /\\\(\\sum_\{i=1\}\^\{n\} x_i \* y_i\\\)/);
  assert.equal(root.querySelectorAll('em').length, 0);
  assert.equal(root.querySelector('strong').textContent, 'ordinary bold');
  const display = '\\[\n\\sum_{i=1}^{n} x_i\n\\]';
  assert.equal(fragment(markdownToHTML(display)).textContent, display);
  assert.equal(fragment(markdownToHTML('The command \\sum remains literal.')).textContent, 'The command \\sum remains literal.');
});

test('keeps normal Markdown punctuation escapes outside protected math spans', () => {
  const root = fragment(markdownToHTML('Escaped \\*star\\* and \\[unmatched bracket.'));
  assert.equal(root.textContent, 'Escaped *star* and [unmatched bracket.');
  assert.equal(root.querySelectorAll('em').length, 0);
});

test('detects explicit inline reading markup and matched math on paste', () => {
  for (const source of ['An **inductive bias** matters.', 'Use `code` here.', 'Read [source](https://example.com).', 'A sum \\(\\sum_i x_i\\).', '\\[\nx_i + y_i\n\\]']) assert.equal(looksLikeMarkdown(source), true);
  for (const source of ['a*b', 'a*b*c', 'variable_name', '>10', 'An ordinary paragraph.', '\\(unmatched']) assert.equal(looksLikeMarkdown(source), false);
});
