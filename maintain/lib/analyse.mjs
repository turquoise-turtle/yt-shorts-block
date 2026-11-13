// Turns scenario results into a short list of issues, each with either a
// ready-made edit (auto/review) or the context an LLM needs to work it out.
import path from 'node:path';
import { ROOT } from './inventory.mjs';

const rel = (p) => (p ? path.relative(ROOT, p) : p);
const SIMPLE = /^([a-z][\w-]*|#[\w-]+|\.[\w-]+)$/i;

const HINTS = {
  injected: 'Check manifest.json content_scripts matches and look for a syntax or runtime error in content.js.',
  host: 'Add the new host to content_scripts.matches in manifest.json, and to README.md Limitations if it is new coverage.',
  'url-pattern': 'Update isShortsPath in content.js (also used by parseRedirectUrl) and the Shorts address checks; the URL pattern is the base of everything else.',
  blocked: 'The path matches but the class was not set: look for an exception in content.js, or a change in when the page becomes ready (document_start, DOMContentLoaded).',
  'block-screen': 'The box the block screen is drawn on (#player-container on desktop, <shorts-video> on mobile) was renamed or no longer keeps its size. Pick the element that holds the video and keeps its size, and update every rule that names it.',
  paused: 'Check pauseVideos in content.js and the capture-phase play listener; YouTube may play through something other than a <video> element or start playback before the class is set.',
  'no-leaks': 'Hide the reported element(s) in the first display:none rule of block.css for this platform, scoped under .ytsb-blocked.',
  inputs: 'YouTube now moves between Shorts through an input content.js does not swallow (wheel, touchmove and keydown are handled). Look for scroll-snap scrolling of a container or pointer events.',
  'spa-block': 'Compare eventsSeen with the events content.js listens for. Desktop needs an event that fires before the Short starts playing and carries detail.pageType; mobile needs one fired once the URL has changed.',
  'spa-unblock': 'Leaving a Short is no longer detected; compare eventsSeen with the listened-for events. On desktop the block lifts on yt-navigate-finish, not yt-navigate-start.',
  'spa-paused': 'The Short played after in-app navigation: the play listener or pauseVideos no longer covers the player.',
  redirect: 'Check maybeRedirect and parseRedirectUrl in content.js, and that loadSettings still runs.',
  'redirect-spa': 'The redirect after in-app navigation failed; it depends on setBlocked being reached through the navigation events.',
  'redirect-back': 'History handling of the redirect (location.replace vs assign in maybeRedirect) no longer leaves the search page in history.',
  'gate-off': 'loadSettings did not remove ytsb-hide-feeds when hide_shorts_in_feeds is false.',
  'not-blocked': 'isShortsPath or a navigation event marks a non-Short page as a Short.',
  'no-shorts-visible': 'Hide the reported shelf, tab or entry in the first .ytsb-hide-feeds display:none rule of block.css. Never hide something that also holds ordinary videos.',
  detector: 'Open the screenshot. If Shorts are visible there, update labelLeaks in maintain/lib/probe.js so the detector recognises them.',
};
const hintFor = (id) => HINTS[id.replace(/@.*/, '')] || '';

function targetRule(inv, area) {
  const pick = (pred) => inv.rules.find((r) => r.hides && r.selectors.some(pred));
  if (area === 'short-desktop') return pick((s) => s.raw.startsWith('.ytsb-blocked') && s.raw.includes('ytd-shorts'));
  if (area === 'short-mobile') return pick((s) => s.raw.startsWith('.ytsb-blocked') && /shorts-video|ytm-/.test(s.raw));
  return pick((s) => s.raw.startsWith('.ytsb-hide-feeds'));
}

export function analyse(results, inv) {
  const fixes = [];
  const issues = [];
  const warnings = [];
  let n = 0;
  const nextId = () => `F${++n}`;

  // Stale selectors: one fix per broken compound and replacement, so a
  // renamed element that several rules share becomes a single rename.
  const staleGroups = new Map();
  for (const r of results) {
    for (const st of r.stale || []) {
      if (st.invalid) {
        issues.push({ id: nextId(), confidence: 'llm', title: `${st.file}:${st.line} selector is invalid CSS: ${st.raw}`, hint: 'Fix the syntax.' });
        continue;
      }
      const best = (st.candidates || []).find((c) => !c.unsafe);
      const k = `${st.broken}=>${best ? best.compound : ''}`;
      if (!staleGroups.has(k)) staleGroups.set(k, { broken: st.broken, best, selectors: new Map(), scenarios: new Set() });
      const g = staleGroups.get(k);
      g.selectors.set(st.key, st);
      g.scenarios.add(r.name);
    }
  }

  const leakCovered = new Set();
  for (const g of staleGroups.values()) {
    const sels = [...g.selectors.values()];
    const where = sels.map((s) => `${s.file}:${s.line}`).join(', ');
    const scen = [...g.scenarios].join(', ');
    const coversLeak = g.best
      ? results.flatMap((r) => r.leaks.map((l) => ({ r, l }))).filter(({ l }) => l.element === g.best.element)
      : [];
    coversLeak.forEach(({ l }) => leakCovered.add(l));
    const visible = coversLeak.length > 0 || results.some((r) => g.scenarios.has(r.name) && r.leaks.length);

    if (!g.best) {
      const entry = {
        id: nextId(),
        confidence: 'llm',
        title: `Selector part \`${g.broken}\` no longer matches (${where}; on ${scen}) and no similar element was found.`,
        hint: visible
          ? 'Something is visible on this page too: read the outline, find what the selector used to target, and rewrite it.'
          : 'Nothing visibly leaks, so the element may simply be absent from this Short or page. Leave it unless a leak or failed check points at it.',
        outline: rel(results.find((r) => g.scenarios.has(r.name))?.outline),
      };
      (visible ? issues : warnings).push(entry);
      continue;
    }

    const { best } = g;
    let edits;
    if (SIMPLE.test(g.broken) && SIMPLE.test(best.compound)) {
      const files = [...new Set(sels.map((s) => s.file))];
      edits = files.map((file) => ({ file, token: g.broken, replace: best.compound }));
    } else {
      edits = sels.map((s) => ({ file: s.file, line: s.line, find: g.broken, replace: best.compound }));
    }
    const confidence = best.score >= 0.55 ? 'auto' : 'review';
    const fix = {
      id: nextId(),
      confidence,
      title: `\`${g.broken}\` -> \`${best.compound}\` (${where})`,
      detail: `No longer matches on ${scen}. Closest element now: ${best.element} (similarity ${best.score}); rewritten selector \`${best.selector}\` matches ${best.matches}.${coversLeak.length ? ' It is the element that leaks.' : ''}`,
      edits,
    };
    if (visible || confidence === 'auto') fixes.push(fix);
    else warnings.push({ ...fix, note: 'Not applied by "fix auto": low similarity and nothing visibly leaks.' });
  }

  // A renamed element can make whole containers look like leaks and break
  // other checks, so a page with rename fixes is judged again after them.
  const renamed = new Map();
  for (const g of staleGroups.values()) {
    const f = fixes.find((x) => x.title.startsWith(`\`${g.broken}\``));
    if (f) for (const name of g.scenarios) renamed.set(name, [...(renamed.get(name) || []), f.id]);
  }
  const deferred = (r) => renamed.get(r.name);

  for (const r of results) {
    const pending = r.leaks.filter((l) => !leakCovered.has(l));
    if (deferred(r) && pending.length) {
      warnings.push({ id: nextId(), confidence: 'after-fix', title: `${r.name}: ${pending.length} visible element(s) not yet addressed; re-check after ${deferred(r).join(', ')}.` });
      continue;
    }
    for (const l of r.leaks) {
      if (leakCovered.has(l)) continue;
      const rule = targetRule(inv, l.area);
      const last = rule && rule.selectors[rule.selectors.length - 1];
      const where = `${r.name}${l.width ? ` at ${l.width}px` : ''}`;
      if (l.suggest && last) {
        const dup = fixes.find((f) => f.addSelector === l.suggest.selector);
        if (dup) {
          dup.detail += ` Also seen on ${where}.`;
          continue;
        }
        fixes.push({
          id: nextId(),
          confidence: 'auto',
          title: `Hide ${l.element} (${where})`,
          detail: `Visible: ${l.sample}, inside ${l.path}. Adds \`${l.suggest.selector}\` (matches ${l.suggest.matches}) to the rule ending at block.css:${last.line}.`,
          addSelector: l.suggest.selector,
          edits: [{ file: 'block.css', line: last.line, find: `${last.raw} {`, replace: `${last.raw},\n${l.suggest.selector} {` }],
        });
      } else {
        issues.push({
          id: nextId(),
          confidence: 'llm',
          title: `Visible on ${where}: ${l.element}`,
          hint: `No safe selector could be generated. ${hintFor(l.area === 'feed' ? 'no-shorts-visible' : 'no-leaks')}`,
          detail: `Sample: ${l.sample}, inside ${l.path}.`,
          outline: rel(r.outline),
        });
      }
    }
  }

  for (const r of results) {
    if (r.error) {
      issues.push({ id: nextId(), confidence: 'env', title: r.error, hint: 'Re-run the check; if it persists, open the screenshot.', screenshot: rel(r.screenshot) });
      continue;
    }
    for (const c of r.checks) {
      if (c.ok === true) continue;
      if (/^no-leaks|^no-shorts-visible/.test(c.id) && r.leaks.length) continue;
      if (deferred(r)) {
        warnings.push({ id: nextId(), confidence: 'after-fix', title: `${r.name} ${c.id} failed, probably because of the renamed selectors; re-check after ${deferred(r).join(', ')}.` });
        continue;
      }
      const entry = {
        id: nextId(),
        confidence: 'llm',
        title: `${r.name} ${c.id}: ${c.msg}`,
        hint: hintFor(c.id),
        ...(c.data ? { data: c.data } : {}),
        outline: rel(r.outline),
        screenshot: rel(r.screenshot),
      };
      (c.ok === 'warn' ? warnings : issues).push(entry);
    }
    if (r.retried) warnings.push({ id: nextId(), confidence: 'info', title: `${r.name} failed once and passed on retry: ${r.retried}` });
  }

  const status = results.some((r) => r.error)
    ? 'error'
    : fixes.length || issues.length
      ? 'fail'
      : warnings.length
        ? 'warn'
        : 'pass';
  return { status, fixes, issues, warnings };
}
