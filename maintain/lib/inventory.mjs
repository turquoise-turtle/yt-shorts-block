// Reads the extension's own files and lists everything that depends on
// YouTube's markup or behaviour: CSS selectors, selectors in content.js, the
// Shorts URL pattern, the navigation events listened for and the host matches.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXT_FILES = ['manifest.json', 'content.js', 'block.css', 'managed_schema.json'];

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Splits at commas that are not inside (), [] or quotes.
export const splitTopLevel = (text) => {
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push({ text: text.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  out.push({ text: text.slice(start), offset: start });
  return out;
};

const lineAt = (src, offset) => src.slice(0, offset).split('\n').length;
export const norm = (s) => s.replace(/\s+/g, ' ').trim();
export const stripPseudo = (s) => s.replace(/::?(before|after|marker|placeholder)\b/g, '');
export const gateOf = (sel) => (sel.match(/^((?:\.ytsb-[\w-]+)+)\s/) || [])[1] || '';

export function parseCss(file = 'block.css') {
  const src = read(file);
  // Blank out comments but keep offsets, so line numbers stay right.
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const rules = [];
  let pos = 0;
  while (true) {
    const open = clean.indexOf('{', pos);
    if (open < 0) break;
    const close = clean.indexOf('}', open);
    const selText = clean.slice(pos, open);
    const decls = clean.slice(open + 1, close);
    const selectors = splitTopLevel(selText)
      .map(({ text, offset }) => {
        const lead = text.length - text.trimStart().length;
        return { raw: text.trim(), line: lineAt(src, pos + offset + lead) };
      })
      .filter((s) => s.raw);
    rules.push({
      index: rules.length,
      selectors,
      hides: /display\s*:\s*none/.test(decls),
      blockScreen: /content\s*:/.test(decls) && selectors.some((s) => /::after/.test(s.raw)),
      decls: norm(decls),
    });
    pos = close + 1;
  }
  return rules;
}

export function parseContent(file = 'content.js') {
  const src = read(file);
  const selectors = [];
  for (const m of src.matchAll(/querySelector(?:All)?\(\s*'([^']+)'/g)) {
    for (const part of splitTopLevel(m[1])) {
      selectors.push({ raw: part.text.trim(), line: lineAt(src, m.index) });
    }
  }
  const STANDARD = new Set(['play', 'wheel', 'touchmove', 'keydown', 'DOMContentLoaded']);
  const events = [...src.matchAll(/(document|window)\.addEventListener\(\s*'([\w-]+)'/g)]
    .filter((m) => !STANDARD.has(m[2]))
    .map((m) => ({ target: m[1], name: m[2], line: lineAt(src, m.index) }));
  const re = src.match(/isShortsPath\s*=[^\n]*?=>\s*\/(.+?)\/([gimsuy]*)\.test/);
  const pageType = src.match(/pageType\s*===\s*'([\w-]+)'/);
  return {
    selectors,
    events,
    shortsPath: re ? { source: re[1], flags: re[2], line: lineAt(src, re.index) } : null,
    pageType: pageType ? pageType[1] : null,
  };
}

const matchPatternToRegex = (p) =>
  new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

export function inventory() {
  const rules = parseCss();
  const content = parseContent();
  const manifest = JSON.parse(read('manifest.json'));
  const matches = manifest.content_scripts.flatMap((c) => c.matches);
  const selectors = [
    ...rules.flatMap((r) =>
      r.selectors.map((s) => ({ file: 'block.css', line: s.line, raw: s.raw, rule: r.index, hides: r.hides }))
    ),
    ...content.selectors.map((s) => ({ file: 'content.js', line: s.line, raw: s.raw })),
  ].map((s) => ({ ...s, key: `${s.file}|${norm(s.raw)}`, query: stripPseudo(s.raw), gate: gateOf(s.raw) }));

  const keep = rules
    .filter((r) => r.blockScreen)
    .flatMap((r) => r.selectors.map((s) => stripPseudo(s.raw)));

  return {
    rules,
    selectors,
    keep: [...new Set(keep)].join(', '),
    events: content.events,
    shortsPath: content.shortsPath,
    isShortsPath: content.shortsPath
      ? (p) => new RegExp(content.shortsPath.source, content.shortsPath.flags).test(p)
      : null,
    pageType: content.pageType,
    matches,
    hostCovered: (url) => matches.some((m) => matchPatternToRegex(m).test(url)),
    version: manifest.version,
  };
}

export const filesHash = () => {
  const h = crypto.createHash('sha256');
  for (const f of EXT_FILES) h.update(read(f));
  return h.digest('hex').slice(0, 16);
};
