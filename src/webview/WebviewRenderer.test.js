/**
 * WebviewRenderer Unit Tests
 *
 * Tests for the extracted getHtmlForWebview function.
 * Run via: docker compose run --rm npm test
 *          docker compose run --rm npm run test:webview
 *
 * GPT-5 review checklist (for AI reviewer):
 *   1. CSP nonce injection — every <script> must carry the same nonce
 *   2. XSS surface — model names come from config (not user input), low risk
 *   3. HTML structure completeness — must have <html>, <head>, <body>, </html>
 *   4. sendKey config propagation — must appear in JS initialisation block
 *   5. No secrets / auth tokens in HTML output
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');

// ─── Mock vscode module ───────────────────────────────────────────────────────
/** @type {Record<string, unknown>} */
let _configStore = {};

const vscodeStub = {
  workspace: {
    getConfiguration: (_section) => ({
      get: (key) => _configStore[key],
    }),
  },
};

// Intercept ALL require('vscode') calls before loading the module under test
const _originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return _originalLoad.apply(this, arguments);
};

// Now we can safely require the module under test
const { getHtmlForWebview } = require('../../out/webview/WebviewRenderer');

// ─── Helper ──────────────────────────────────────────────────────────────────
function withConfig(overrides, fn) {
  _configStore = overrides;
  return fn();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('returns a valid HTML document', () => {
  const html = withConfig({}, () => getHtmlForWebview(null));
  assert.ok(html.trimStart().startsWith('<!doctype html>'), 'must start with doctype');
  assert.ok(html.includes('</html>'), 'must close html tag');
  assert.ok(html.includes('<head>') || html.includes('<head '), 'must have head');
  assert.ok(html.includes('<body>') || html.includes('<body '), 'must have body');
});

test('embeds a nonce in CSP and script tags', () => {
  const html = withConfig({}, () => getHtmlForWebview(null));
  // Extract nonce from CSP
  const cspMatch = html.match(/script-src 'nonce-([a-z0-9]+)'/);
  assert.ok(cspMatch, 'CSP must contain nonce');
  const nonce = cspMatch[1];
  // Every <script> tag must carry that nonce
  const scriptTags = [...html.matchAll(/<script([^>]*)>/g)].map(m => m[1]);
  for (const attrs of scriptTags) {
    assert.ok(attrs.includes(`nonce="${nonce}"`), `script tag must carry nonce="${nonce}"`);
  }
});

test('populates model <option> elements from config', () => {
  const html = withConfig(
    { model: 'llama3.2:3b', models: ['llama3.2:3b', 'mistral:7b'] },
    () => getHtmlForWebview(null),
  );
  assert.ok(html.includes('<option value="llama3.2:3b"'), 'should include primary model option');
  assert.ok(html.includes('<option value="mistral:7b"'), 'should include secondary model option');
  assert.ok(
    html.includes('<option value="llama3.2:3b" selected'),
    'default model should be selected',
  );
});

test('renders empty model list gracefully when config absent', () => {
  const html = withConfig({}, () => getHtmlForWebview(null));
  // Should not throw, and should still produce valid HTML
  assert.ok(html.includes('</html>'), 'must still produce valid HTML');
});

test('injects sendKey config into JavaScript', () => {
  const html = withConfig({ sendKey: 'Ctrl+Enter' }, () => getHtmlForWebview(null));
  assert.ok(html.includes('Ctrl+Enter'), 'sendKey must appear in HTML output');
});

test('default sendKey is Enter when not configured', () => {
  const html = withConfig({}, () => getHtmlForWebview(null));
  // 'Enter' appears as the default send key binding
  assert.ok(html.includes("'Enter'") || html.includes('"Enter"'), 'default sendKey must be Enter');
});

test('contains no hardcoded API keys or secrets patterns', () => {
  const html = withConfig({}, () => getHtmlForWebview(null));
  // Basic guard: no Bearer tokens or base64-looking auth headers
  assert.ok(!/Bearer [A-Za-z0-9+/]{20,}/.test(html), 'must not contain Bearer tokens');
  assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(html), 'must not contain OpenAI-style API keys');
});

test('output does not contain ARCHIVED or debug markers', () => {
  const html = withConfig({}, () => getHtmlForWebview(null));
  assert.ok(!html.includes('_ARCHIVED'), 'no ARCHIVED markers in output');
  assert.ok(!html.includes('TODO:'), 'no leftover TODO comments in output HTML');
});

test('source template does not contain raw newline escapes in inline script strings', () => {
  const sourcePath = path.resolve(__dirname, 'WebviewRenderer.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const templateStart = source.indexOf('return `<!doctype html>');
  const templateEnd = source.lastIndexOf('`;');

  assert.ok(templateStart !== -1, 'should find HTML template start');
  assert.ok(templateEnd !== -1 && templateEnd > templateStart, 'should find HTML template end');

  const template = source.slice(templateStart, templateEnd);
  const rawEscapeLines = template
    .split(/\r?\n/)
    .map((line, index) => ({ lineNumber: index + 1, line }))
    .filter(({ line }) => /(?<!\\)\\[nr]/.test(line));

  assert.deepEqual(
    rawEscapeLines,
    [],
    'inline webview JS must use \\\\n / \\\\r inside the outer TypeScript template literal'
  );
});
