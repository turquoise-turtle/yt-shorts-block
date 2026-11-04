#!/usr/bin/env node
// Maintenance harness for Shorts Block. Run `node maintain/cli.mjs help`.
// Output is kept short on purpose: it is read by LLM agents, and every line
// costs tokens. Full details go to maintain/out/report.md.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inventory, filesHash, ROOT, EXT_FILES } from './lib/inventory.mjs';
import { launch, OUT, HARNESS } from './lib/browser.mjs';
import { scenarios, runScenario, openScenario } from './lib/scenarios.mjs';
import { analyse } from './lib/analyse.mjs';

const CONFIG = path.join(HARNESS, 'config.json');
const BASELINE = path.join(HARNESS, 'baseline.json');
const REPORT = path.join(OUT, 'report.json');
const APPLIED = path.join(OUT, 'applied.json');
const CLI = 'node maintain/cli.mjs';

const readJson = (f, fallback = null) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : fallback);
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
const rel = (p) => path.relative(ROOT, p);
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const today = () => new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const opts = (name) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []));
const VALUE_OPTS = new Set(['--only', '--lines', '--co-author', '--simulate']);
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !VALUE_OPTS.has(all[i - 1]));

fs.mkdirSync(OUT, { recursive: true });

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    })
  );
  return out;
}

const failed = (r) => r.error || r.checks.some((c) => c.ok === false) || r.leaks.length > 0;

async function runCheck({ only, quick, simulate } = {}) {
  const cfg = readJson(CONFIG);
  const inv = inventory();
  const baseline = readJson(BASELINE);
  let list = scenarios(cfg);
  if (only) list = list.filter((s) => only.includes(s.name));
  if (quick) list = list.filter((s) => s.variant === 'default');
  if (!list.length) throw new Error(`No scenario matches. Names: ${scenarios(cfg).map((s) => s.name).join(', ')}`);

  const started = new Date();
  const hash = filesHash();
  if (!simulate) console.error(`Running ${list.length} scenario(s) against the live site; this takes about ${Math.ceil(list.length * 6)} seconds...`);
  const variants = [...new Set(list.map((s) => s.variant))];
  let chrome = '';
  const results = (
    await Promise.all(
      variants.map(async (v) => {
        const { browser, newPage, chrome: c } = await launch(v, { simulate });
        chrome = c;
        const ctx = { inv, cfg, baseline, newPage };
        try {
          return await pool(
            list.filter((s) => s.variant === v),
            cfg.concurrency,
            async (s) => {
              const first = await runScenario(s, ctx);
              if (!failed(first)) return first;
              const second = await runScenario(s, ctx);
              const why = [`at ${first.url}`, first.error, ...first.checks.filter((c) => c.ok === false).map((c) => `${c.id}: ${c.msg}`)].filter(Boolean);
              if (first.leaks.length) why.push(`leaks: ${first.leaks.map((l) => l.element).join(', ')}`);
              return failed(second) ? second : { ...second, retried: why.join(' | ').slice(0, 300) };
            }
          );
        } finally {
          await browser.close().catch(() => {});
        }
      })
    )
  ).flat();
  results.sort((a, b) => list.findIndex((s) => s.name === a.name) - list.findIndex((s) => s.name === b.name));

  const analysis = analyse(results, inv);
  const unverified = inv.selectors.filter(
    (s) => !results.some((r) => r.counts && r.counts[s.key]?.n > 0) && !(baseline && baseline.selectors[s.key])
  );
  return {
    startedAt: started.toISOString(),
    version: inv.version,
    chrome,
    filesHash: hash,
    full: !only && !quick && !simulate,
    scenarios: results.map((r) => r.name),
    ...analysis,
    unverified: unverified.map((s) => `${s.file}:${s.line} ${s.raw}`),
    noBaseline: !baseline,
    results,
  };
}

async function check() {
  const report = await runCheck({ only: opt('only')?.split(','), quick: flag('quick'), simulate: opt('simulate') });
  writeJson(REPORT, report);
  fs.writeFileSync(path.join(OUT, 'report.md'), reportMd(report));
  printSummary(report);
  process.exitCode = { pass: 0, warn: 0, fail: 1, error: 2 }[report.status];
}

// Proves the harness still notices the kinds of change YouTube makes, by
// rewriting the live page the way such a change would and checking that the
// diagnosis names the right cause and fix.
const SELFTESTS = [
  {
    sim: 'rename-player',
    only: ['desktop-short'],
    expect: (r) => r.fixes.some((f) => f.confidence === 'auto' && f.edits.some((e) => e.token === '#player-container' && e.replace === '#player-box')),
    want: 'auto fix renaming #player-container to #player-box',
  },
  {
    sim: 'rename-overlay',
    only: ['desktop-short'],
    expect: (r) => r.fixes.some((f) => f.edits.some((e) => (e.replace || '').includes('reel-action-bar-renderer-v2'))),
    want: 'fix that targets reel-action-bar-renderer-v2',
  },
  {
    sim: 'new-shelf',
    only: ['desktop-search'],
    expect: (r) => r.fixes.some((f) => f.edits.some((e) => (e.replace || '').includes('shorts-grid-shelf'))),
    want: 'fix that targets shorts-grid-shelf',
  },
  {
    sim: 'new-nav-event',
    only: ['desktop-search'],
    expect: (r) => r.issues.some((i) => /spa-block/.test(i.title) && JSON.stringify(i.data || {}).includes('yt-nav-begin')),
    want: 'spa-block issue listing yt-nav-begin among the events seen',
  },
  {
    sim: 'shorts-url',
    only: ['desktop-short'],
    expect: (r) => r.issues.some((i) => /url-pattern/.test(i.title) && i.title.includes('/reel/')),
    want: 'url-pattern issue naming the /reel/ path',
  },
];

async function selftest() {
  if (!fs.existsSync(BASELINE)) return console.log(`No baseline; run \`${CLI} check\` and \`${CLI} record\` first.`);
  const pick = positional[0]?.split(',');
  let bad = 0;
  for (const t of SELFTESTS.filter((x) => !pick || pick.includes(x.sim))) {
    const r = await runCheck({ only: t.only, simulate: t.sim });
    const ok = t.expect(r);
    if (!ok) bad++;
    writeJson(path.join(OUT, `selftest-${t.sim}.json`), r);
    const got = [...r.fixes, ...r.issues].map((x) => `${x.confidence}: ${x.title}`).join(' / ').slice(0, 220) || r.status;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${t.sim}: expected ${t.want}${ok ? '' : `; got ${got}`}`);
  }
  console.log(bad ? `${bad} self-test(s) failed: the harness would miss that kind of YouTube change. Details in maintain/out/selftest-*.json.` : 'All self-tests passed.');
  process.exitCode = bad ? 1 : 0;
}

function reportMd(r) {
  const out = [`# Shorts Block live check ${r.startedAt}`, '', `Status: **${r.status}**, version ${r.version}, Chrome ${r.chrome}`, ''];
  for (const res of r.results) {
    out.push(`## ${res.name} ${res.error ? 'ERROR' : failed(res) ? 'FAIL' : 'ok'}`, '', `URL: ${res.url || '-'}`, '');
    if (res.error) out.push(`- error: ${res.error}`);
    for (const c of res.checks) out.push(`- ${c.ok === true ? 'ok' : c.ok === 'warn' ? 'warn' : 'FAIL'} ${c.id}: ${c.msg}${c.data ? `\n  - data: ${JSON.stringify(c.data)}` : ''}`);
    for (const l of res.leaks) out.push(`- leak: ${l.element} in ${l.path}; sample ${l.sample}; suggest ${l.suggest?.selector || 'none'}`);
    for (const s of res.stale) out.push(`- stale: ${s.file}:${s.line} ${s.raw} (broken part ${s.broken}; candidates ${JSON.stringify(s.candidates || [])})`);
    if (res.outline) out.push(`- outline: ${rel(res.outline)}`);
    if (res.screenshot) out.push(`- screenshot: ${rel(res.screenshot)}`);
    out.push('');
  }
  out.push('## Selectors never matched in any scenario', '', ...r.unverified.map((u) => `- ${u}`), '');
  return out.join('\n');
}

// The summary is the agent's whole view of a run, so it is also saved, and
// `summary` reprints it for agents whose shell tool ran the check in the
// background or truncated its output.
function summaryOf(r) {
  const failing = r.results.filter(failed).map((x) => x.name);
  const lines = [
    `Shorts Block ${r.version} live check in Chrome ${r.chrome}: ${r.status.toUpperCase()} (${r.results.length} scenarios${failing.length ? `, failing: ${failing.join(', ')}` : ''})`,
  ];
  const show = (x) => {
    lines.push(`${x.id} [${x.confidence}] ${x.title}`);
    for (const k of ['detail', 'hint', 'note']) if (x[k]) lines.push(`   ${x[k]}`);
    if (x.data) lines.push(`   data: ${JSON.stringify(x.data)}`);
    if (x.outline) lines.push(`   outline: ${x.outline}`);
  };
  r.fixes.forEach(show);
  r.issues.forEach(show);
  if (r.warnings.length) {
    lines.push(`Warnings (${r.warnings.length}, no action needed unless a failure points at them):`);
    r.warnings.slice(0, 4).forEach((w) => lines.push(`   ${w.id} ${w.title}`));
  }
  if (r.unverified.length) lines.push(`${r.unverified.length} selector(s) matched nothing on any page tested (listed in report.md); not a failure.`);
  if (r.noBaseline) lines.push('No baseline yet, so renamed selectors cannot be detected; `finish` records one.');
  lines.push(`Details: maintain/out/report.md`);
  lines.push(`NEXT: ${nextSteps(r).join(' ')}`);
  return lines.join('\n');
}

function nextSteps(r) {
  const auto = r.fixes.filter((f) => f.confidence === 'auto').map((f) => f.id);
  const review = r.fixes.filter((f) => f.confidence === 'review').map((f) => f.id);
  const llm = r.issues.filter((i) => i.confidence === 'llm').map((i) => i.id);
  const next = [];
  if (r.status === 'error') next.push(`Environment problem; re-run \`${CLI} check\` before changing any file.`);
  if (auto.length) next.push(`\`${CLI} fix auto\` applies ${auto.join(', ')} and re-runs the check.`);
  if (review.length) next.push(`Review ${review.join(', ')}; apply with \`${CLI} fix ${review.join(',')}\` if they look right.`);
  if (llm.length)
    next.push(
      `${llm.join(', ')} need reasoning: read the outline file(s) named above, edit block.css/content.js, test selectors with \`${CLI} try <scenario> '<selector>'\`, then \`${CLI} check\`.`
    );
  if (r.status === 'pass' || r.status === 'warn')
    next.push(r.full ? `\`${CLI} finish\` records the baseline, bumps the version if extension files changed, and commits.` : `Run the full \`${CLI} check\` before finishing.`);
  return next;
}

// Compact machine-readable form for agents that prefer JSON to prose.
const jsonOf = (r) => ({
  status: r.status,
  version: r.version,
  chrome: r.chrome,
  failing: r.results.filter(failed).map((x) => x.name),
  findings: [...r.fixes, ...r.issues].map(({ id, confidence, title, detail, hint, data, outline }) => ({ id, confidence, title, detail, hint, data, outline })),
  warnings: r.warnings.map((w) => w.title),
  next: nextSteps(r),
});

function printSummary(r) {
  const text = summaryOf(r);
  fs.writeFileSync(path.join(OUT, 'summary.txt'), text + '\n');
  console.log(flag('json') ? JSON.stringify(jsonOf(r)) : text);
}

function summary() {
  const report = readJson(REPORT);
  if (!report) return console.log(`No report; run \`${CLI} check\` first.`);
  if (!flag('json')) console.log(`(from the check started ${report.startedAt})`);
  printSummary(report);
}

function applyFixes() {
  const report = readJson(REPORT);
  if (!report) return console.log(`No report; run \`${CLI} check\` first.`);
  const want = positional[0] || 'auto';
  const all = [...report.fixes, ...report.warnings.filter((w) => w.edits)];
  const chosen =
    want === 'auto'
      ? report.fixes.filter((f) => f.confidence === 'auto')
      : want === 'all'
        ? report.fixes
        : all.filter((f) => want.split(',').includes(f.id));
  if (!chosen.length) return console.log('Nothing to apply.');
  if (report.filesHash !== filesHash()) console.log('Note: extension files changed since the report; edits are matched by text, not just line.');

  const byFile = new Map();
  const results = [];
  for (const f of chosen) for (const e of f.edits) {
    if (!byFile.has(e.file)) byFile.set(e.file, fs.readFileSync(path.join(ROOT, e.file), 'utf8'));
  }
  for (const f of chosen) {
    let ok = true;
    // Insertions shift line numbers, so later lines go first.
    const edits = [...f.edits].sort((a, b) => (b.line || 0) - (a.line || 0));
    for (const e of edits) {
      let src = byFile.get(e.file);
      if (e.token) {
        const re = new RegExp(`(?<![\\w-])${e.token.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&')}(?![\\w-])`, 'g');
        const n = (src.match(re) || []).length;
        if (!n) ok = false;
        else src = src.replace(re, e.replace);
      } else {
        const lines = src.split('\n');
        const i = e.line - 1;
        if (lines[i] && lines[i].includes(e.find)) {
          lines[i] = lines[i].replace(e.find, e.replace);
          src = lines.join('\n');
        } else if (src.split(e.find).length === 2) {
          src = src.replace(e.find, e.replace);
        } else ok = false;
      }
      byFile.set(e.file, src);
    }
    results.push({ id: f.id, ok, title: f.title });
  }
  for (const [file, src] of byFile) fs.writeFileSync(path.join(ROOT, file), src);
  const applied = readJson(APPLIED, []);
  for (const r of results) if (r.ok) applied.push({ id: r.id, title: r.title, at: new Date().toISOString() });
  writeJson(APPLIED, applied);
  for (const r of results) console.log(`${r.ok ? 'applied' : 'COULD NOT APPLY'} ${r.id} ${r.title}`);
  if (results.some((r) => !r.ok)) console.log('Edit the failed ones by hand; the report has the intended change.');
  return results.some((r) => r.ok);
}

async function tryOrOutline(kind) {
  const cfg = readJson(CONFIG);
  const inv = inventory();
  const name = positional[0];
  const s = scenarios(cfg).find((x) => x.name === name);
  if (!s) return console.log(`Unknown scenario. Names: ${scenarios(cfg).map((x) => x.name).join(', ')}`);
  const { browser, newPage } = await launch(s.variant);
  try {
    const page = await openScenario(s, { inv, cfg, newPage });
    if (kind === 'try') {
      const sels = positional.slice(1);
      if (!sels.length) return console.log(`Usage: ${CLI} try <scenario> '<selector>' ['<selector>' ...]`);
      for (const sel of sels) {
        const r = await page.probe((x, k) => __ytsb.tryOut(x, k), sel, inv.keep);
        if (r.error) console.log(`${sel}: ${r.error}`);
        else {
          console.log(`${sel}: ${r.matches} match(es), ${r.visible} visible${r.unsafe ? ', UNSAFE: would hide the block screen' : ''}${r.ordinary ? `, UNSAFE: ${r.ordinary} hold ordinary videos` : ''}`);
          r.sample.forEach((x) => console.log(`   ${x}`));
        }
      }
    } else {
      const root = positional[1] || (s.kind === 'short' ? cfg.roots[s.device] : s.device === 'desktop' ? 'ytd-page-manager' : 'ytm-app');
      const lines = Number(opt('lines') || 300);
      const text = await page.probe((r, n) => __ytsb.outline(r, n), root, lines);
      const file = path.join(OUT, `${s.name}.outline.txt`);
      fs.writeFileSync(file, `# ${s.name} ${page.url()}\n# root: ${root}\n${text}\n`);
      console.log(`Wrote ${rel(file)} (${text.split('\n').length} lines, root ${root}). Elements marked data-ytsb-leak are current leaks.`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

function record({ quiet } = {}) {
  const report = readJson(REPORT);
  if (!report) return console.log(`No report; run \`${CLI} check\` first.`), false;
  if (!['pass', 'warn'].includes(report.status) && !flag('force')) {
    console.log(`The last check was ${report.status}; a baseline is only recorded from a passing check (use --force to override).`);
    return false;
  }
  const old = readJson(BASELINE, { selectors: {} });
  const inv = inventory();
  const ran = report.results.filter((r) => r.counts);
  const selectors = {};
  for (const sel of inv.selectors) {
    const prev = old.selectors[sel.key] || { scenarios: {} };
    const scen = { ...prev.scenarios };
    let fps = prev.fps;
    for (const r of ran) {
      const c = r.counts[sel.key];
      if (!c) continue;
      if (c.n > 0) {
        scen[r.name] = c.n;
        if (!fps || r.name === Object.keys(scen)[0]) fps = c.fps;
      } else delete scen[r.name];
    }
    if (Object.keys(scen).length) selectors[sel.key] = { scenarios: scen, fps };
  }
  writeJson(BASELINE, { recorded: report.startedAt, version: inv.version, selectors });
  if (!quiet) console.log(`Baseline recorded: ${Object.keys(selectors).length} of ${inv.selectors.length} selectors seen on the live site.`);
  return true;
}

function bumpPatch(v) {
  const p = v.split('.').map(Number);
  while (p.length < 3) p.push(0);
  p[2]++;
  return p.join('.');
}

function finish() {
  const report = readJson(REPORT);
  if (!report) return console.log(`No report; run \`${CLI} check\` first.`);
  if (!['pass', 'warn'].includes(report.status)) return console.log(`The last check was ${report.status}. Fix it and re-run \`${CLI} check\` before finishing.`);
  if (report.filesHash !== filesHash()) return console.log(`Extension files changed after the last check. Run \`${CLI} check\` again first.`);
  if (!report.full && !flag('allow-partial')) return console.log(`The last check ran only some scenarios. Run the full \`${CLI} check\` first.`);
  const dry = flag('dry-run');

  const extChanged = (() => {
    try {
      git('diff', '--quiet', 'HEAD', '--', ...EXT_FILES);
      return false;
    } catch {
      return true;
    }
  })();
  const manifestPath = path.join(ROOT, 'manifest.json');
  const manifestSrc = fs.readFileSync(manifestPath, 'utf8');
  const current = JSON.parse(manifestSrc).version;
  const headVersion = JSON.parse(git('show', 'HEAD:manifest.json')).version;
  let version = current;
  if (extChanged && current === headVersion) version = bumpPatch(current);

  const applied = readJson(APPLIED, []);
  const date = today();
  const plan = [
    version !== current ? `bump manifest version ${current} -> ${version}` : `keep version ${current}`,
    `set README "last checked" date to ${date}`,
    'record maintain/baseline.json',
    'commit (not push)',
  ];
  if (dry) return console.log(`Would: ${plan.join('; ')}.`);

  if (!record({ quiet: true })) return;
  if (version !== current) fs.writeFileSync(manifestPath, manifestSrc.replace(`"version": "${current}"`, `"version": "${version}"`));
  const readme = path.join(ROOT, 'README.md');
  fs.writeFileSync(
    readme,
    fs.readFileSync(readme, 'utf8').replace(/(last checked against the live site on )([^.]+)(\.)/, `$1${date}$3`)
  );

  const subject = extChanged ? `Update selectors for YouTube markup changes (${version})` : 'Recheck selectors against the live site';
  const body = [
    ...applied.map((a) => `- ${a.title.replace(/`/g, '')}`),
    `${applied.length ? '\n' : ''}Live check passed on ${report.results.length} scenarios (${report.status}) on ${date}.`,
  ].join('\n');
  const trailers = opts('co-author').map((c) => `Co-Authored-By: ${c}`);
  const message = [subject, '', body, ...(trailers.length ? ['', ...trailers] : [])].join('\n');

  git('add', '--', ...EXT_FILES, 'README.md', 'maintain');
  const staged = git('diff', '--cached', '--name-only');
  if (!staged) return console.log('Nothing changed; nothing to commit.');
  git('commit', '-m', message, '--', ...staged.split('\n'));
  fs.rmSync(APPLIED, { force: true });
  const hash = git('rev-parse', '--short', 'HEAD');
  updateState(`${date}: live check ${report.status} on ${report.results.length} scenarios; ${applied.length} fix(es) applied; committed ${hash} (${subject}), not pushed.`);
  console.log(`Committed ${hash}: ${subject}. Files: ${staged.split('\n').join(', ')}. Not pushed.`);
}

// Keeps one current line about maintenance in the local handover note, so a
// fresh session knows when the selectors were last proven against the site.
function updateState(line) {
  const file = path.join(ROOT, '.agent', 'STATE.md');
  if (!fs.existsSync(file)) return;
  const src = fs.readFileSync(file, 'utf8');
  const section = `## Last maintenance check\n\n${line} Run \`${CLI} check\` to repeat.\n`;
  const re = /## Last maintenance check\n[\s\S]*?(?=\n## |$)/;
  fs.writeFileSync(file, re.test(src) ? src.replace(re, section) : src.trimEnd() + '\n\n' + section);
}

// The one place the agent procedure lives. AGENTS.md only points here, so
// instructions cannot drift from the harness, and an agent that reads no
// instruction file can still be told to run this.
const GUIDE = `Shorts Block maintenance: procedure for any coding agent
Run commands from the repository root. Everything is non-interactive.

1. ${CLI} check
   About 80 seconds (first run also installs dependencies and the latest Chrome). Allow up to 10 minutes.
   If your shell tool cannot wait that long, run it in the background, wait for it to exit, then run \`${CLI} summary\`.
   Exit code 0 = pass or warnings only, 1 = problems found, 2 = environment or harness error.
   Add --json for a single-line JSON summary instead of text.
2. Act on the NEXT: line. Each finding is "F<n> [confidence] title":
   [auto]   verified edit: \`${CLI} fix auto\` applies them all and re-runs the check.
   [review] plausible edit: read its detail; if right, \`${CLI} fix F<n>\`.
   [llm]    needs reasoning: read only the outline file named (one line per element:
            tag#id.classes[attrs] "text" (WxH) or (hidden); data-ytsb-leak marks a leak),
            follow the hint, edit block.css or content.js, test with
            \`${CLI} try <scenario> '<full selector>'\`, then \`${CLI} check\`.
            For navigation failures, data.eventsSeen lists the events YouTube fires now.
   [env]    consent page, bot check or network failure: re-run once; edit nothing because of it.
   [after-fix] warning: apply the named fixes first; it is re-judged on the next check.
3. Repeat until PASS or WARN. Warnings alone need no action.
4. ${CLI} finish [--co-author "Name <email>"]
   Records the baseline, bumps the patch version if extension files changed, updates the
   README "last checked" date and commits. Never pushes. Pass --co-author if your own
   instructions require a commit trailer. Report the commit hash; push only if asked.

Rules for edits: keep the design in README.md (one class on <html>, visuals in CSS, no polling,
input listeners only while blocked). Short-page selectors go under .ytsb-blocked, shelf and tab
selectors under .ytsb-hide-feeds. Never hide the block-screen box or anything holding ordinary
videos (try reports both as UNSAFE). Prefer custom element tag names and stable attributes over
generated class names. Comments explain why; Australian English.
Do not read YouTube pages, maintain/out/report.json or screenshots unless the summary and
outline are not enough. After changing maintain/ code, run \`${CLI} selftest\`.`;

const HELP = `Shorts Block maintenance harness (agents: run \`${CLI} guide\`; people: maintain/README.md)
  guide                          the step-by-step procedure for coding agents
  summary [--json]               reprint the summary of the last check
  check [--quick] [--only a,b] [--json]   run the live tests, diagnose, propose fixes (~1-2 min)
  fix [auto|all|F1,F2] [--no-check]   apply proposed fixes, then re-run the check
  try <scenario> '<selector>' ...    count what a selector matches on a live page
  outline <scenario> [root] [--lines N]   write a readable DOM outline to maintain/out/
  record [--force]               save selector counts from the last check as the baseline
  selftest [name,...]            simulate YouTube changes on the live site and check the diagnosis
  finish [--co-author "Name <email>"] [--dry-run]   baseline, version bump, README date, commit`;

const commands = {
  check,
  fix: async () => {
    if (applyFixes() && !flag('no-check')) await check();
  },
  try: () => tryOrOutline('try'),
  outline: () => tryOrOutline('outline'),
  record: () => record(),
  selftest,
  finish,
  summary,
  guide: () => console.log(GUIDE),
  help: () => console.log(HELP),
};

Promise.resolve().then(() => (commands[cmd] || commands.help)()).catch((e) => {
  console.error(`Harness error: ${e.stack || e.message}`);
  process.exitCode = 2;
});
