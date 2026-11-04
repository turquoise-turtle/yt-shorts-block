// Each scenario opens one live YouTube page with the staged extension and
// returns checks, selector counts, leaks and diagnoses as small JSON.
import fs from 'node:fs';
import path from 'node:path';
import { OUT } from './browser.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 'https://www.youtube.com';
const M = 'https://m.youtube.com';

export function scenarios(cfg) {
  const q = encodeURIComponent(cfg.searchQuery);
  const search = (h) => `${h}/results?search_query=${q}`;
  return [
    { name: 'desktop-short', variant: 'default', device: 'desktop', url: `${W}/shorts/`, kind: 'short' },
    { name: 'desktop-search', variant: 'default', device: 'desktop', url: search(W), kind: 'feed', spa: true },
    { name: 'desktop-home', variant: 'default', device: 'desktop', url: `${W}/`, kind: 'feed', widths: [1400, 1000] },
    { name: 'desktop-channel', variant: 'default', device: 'desktop', url: `${W}/${cfg.channel}`, kind: 'feed' },
    { name: 'mobile-short', variant: 'default', device: 'mobile', url: `${M}/shorts/`, kind: 'short' },
    { name: 'mobile-search', variant: 'default', device: 'mobile', url: search(M), kind: 'feed', spa: true },
    { name: 'mobile-home', variant: 'default', device: 'mobile', url: `${M}/`, kind: 'feed' },
    { name: 'mobile-channel', variant: 'default', device: 'mobile', url: `${M}/${cfg.channel}`, kind: 'feed' },
    { name: 'redirect-desktop-short', variant: 'redirect', device: 'desktop', url: `${W}/shorts/`, kind: 'redirect' },
    { name: 'redirect-desktop-search', variant: 'redirect', device: 'desktop', url: search(W), kind: 'redirect', spa: true },
    { name: 'redirect-mobile-short', variant: 'redirect', device: 'mobile', url: `${M}/shorts/`, kind: 'redirect' },
    { name: 'feedsoff-desktop-search', variant: 'feeds-off', device: 'desktop', url: search(W), kind: 'control' },
    { name: 'feedsoff-desktop-home', variant: 'feeds-off', device: 'desktop', url: `${W}/`, kind: 'control', widths: [1400, 1000] },
    { name: 'feedsoff-mobile-home', variant: 'feeds-off', device: 'mobile', url: `${M}/`, kind: 'control' },
  ];
}

const summariseEvents = (events) => {
  const seen = new Map();
  for (const e of events) {
    const k = `${e.on}:${e.type}${e.pageType ? ` (pageType=${e.pageType})` : ''}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  return [...seen].slice(0, 25).map(([k, n]) => (n > 1 ? `${k} x${n}` : k));
};

const waitFor = async (pred, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(300);
  }
  return false;
};

// YouTube renders long after DOMContentLoaded and never goes network-idle,
// so readiness is judged from the page itself: a video for a Short, or a
// link count that has stopped growing for anything else.
async function waitReady(page, s, cfg) {
  const end = Date.now() + cfg.readyTimeoutMs;
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() < end) {
    const state = await page
      .evaluate((root) => ({ video: !!document.querySelector(`${root} video`), links: document.querySelectorAll('a[href]').length }), cfg.roots[s.device])
      .catch(() => null);
    if (state) {
      if (s.kind === 'short' && state.video) break;
      if (s.kind !== 'short' && s.kind !== 'redirect') {
        if (state.links !== last) {
          last = state.links;
          stableSince = Date.now();
        } else if (state.links > 10 && Date.now() - stableSince > 1500) break;
      }
      if (s.kind === 'redirect') break;
    }
    await sleep(300);
  }
  await sleep(cfg.settleMs);
}

export async function runScenario(s, ctx) {
  const { inv, cfg, baseline, newPage } = ctx;
  const res = { name: s.name, variant: s.variant, device: s.device, kind: s.kind, checks: [], leaks: [], stale: [] };
  const check = (id, ok, msg, data) => res.checks.push({ id, ok, msg, ...(data ? { data } : {}) });
  const page = await newPage(s.device);
  try {
    if (s.widths && s.device === 'desktop') await page.setViewport({ width: s.widths[0], height: 800 });
    await page.goto(s.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitReady(page, s, cfg);
    res.url = page.url();

    if (s.kind === 'redirect') {
      await runRedirect(s, page, check, ctx);
      return res;
    }
    if (await page.probe(() => __ytsb.isBotWall())) {
      res.error = `YouTube showed a consent or bot-check page at ${res.url}; this is an environment problem, not a selector problem.`;
      return res;
    }
    if (!inv.hostCovered(res.url)) {
      check('host', false, `Page ended up on ${new URL(res.url).host}, which the manifest's content_scripts matches (${inv.matches.join(', ')}) do not cover.`);
    }
    const html = await page.probe(() => __ytsb.htmlClass());
    if (s.variant === 'default') {
      check('injected', html.includes('ytsb-hide-feeds'), html.includes('ytsb-hide-feeds') ? 'content script ran' : `content.js did not run on ${res.url} (no ytsb-hide-feeds class on <html>).`);
    }

    // Selectors are counted before any interaction, so the counts describe
    // the page as it first renders.
    if (s.variant === 'default') await countAndDiagnose(s, page, res, ctx);

    if (s.kind === 'short') await runShort(s, page, check, res, ctx, html);
    if (s.kind === 'feed' || s.kind === 'control') await runFeed(s, page, check, res, ctx, html);

    if (res.checks.some((c) => c.ok === false) || res.leaks.length) {
      const root = s.kind === 'short' ? cfg.roots[s.device] : 'body';
      const outlineRoot = res.leaks.length ? '[data-ytsb-leak-ctx="0"]' : root;
      const text = await page.probe((r) => __ytsb.outline(r, 300), outlineRoot);
      res.outline = path.join(OUT, `${s.name}.outline.txt`);
      fs.writeFileSync(res.outline, `# ${s.name} ${res.url}\n# root: ${outlineRoot}\n${text}\n`);
    }
  } catch (e) {
    res.error = `${s.name}: ${e.message.split('\n')[0]}`;
  } finally {
    try {
      res.screenshot = path.join(OUT, `${s.name}.png`);
      await page.screenshot({ path: res.screenshot });
    } catch {}
    await page.close().catch(() => {});
  }
  return res;
}

async function countAndDiagnose(s, page, res, { inv, baseline }) {
  const queries = [...new Set(inv.selectors.map((x) => x.query))];
  const counts = await page.probe((q) => __ytsb.count(q, true), queries);
  res.counts = {};
  for (const sel of inv.selectors) res.counts[sel.key] = counts[sel.query];
  if (!baseline) return;
  const diagnosed = new Map();
  for (const sel of inv.selectors) {
    const b = baseline.selectors[sel.key];
    const was = b && b.scenarios[s.name];
    const now = counts[sel.query];
    if (now.n === -1) {
      res.stale.push({ key: sel.key, file: sel.file, line: sel.line, raw: sel.raw, invalid: true });
      continue;
    }
    if (!was || now.n > 0) continue;
    if (!diagnosed.has(sel.query)) {
      diagnosed.set(sel.query, await page.probe((q, f, k) => __ytsb.diagnose(q, f, k), sel.query, b.fps || null, inv.keep));
    }
    res.stale.push({ key: sel.key, file: sel.file, line: sel.line, raw: sel.raw, was, ...diagnosed.get(sel.query) });
  }
}

async function runShort(s, page, check, res, { inv, cfg }, html) {
  const p = pathname();
  function pathname() {
    return new URL(page.url()).pathname;
  }
  const pathOk = inv.isShortsPath ? inv.isShortsPath(p) : false;
  check(
    'url-pattern',
    pathOk,
    pathOk
      ? `path ${p} matches isShortsPath`
      : `The Short opened at path "${p}", which isShortsPath /${inv.shortsPath?.source}/ (content.js:${inv.shortsPath?.line}) does not match. YouTube may have changed the Shorts URL.`
  );
  const blocked = html.includes('ytsb-blocked');
  check('blocked', blocked, blocked ? 'ytsb-blocked set on cold load' : `<html> lacks ytsb-blocked on a cold load of ${page.url()}.`);

  const bs = await page.probe((k) => __ytsb.pseudoContent(k), inv.keep);
  const bsOk = !!bs && /blocked/i.test(bs.after) && bs.visible && bs.w >= 150 && bs.h >= 150;
  check(
    'block-screen',
    bsOk,
    bs
      ? `block screen ${bs.w}x${bs.h}, visible=${bs.visible}, ::after ${bs.after.slice(0, 50)}`
      : `No element matches the block-screen selectors (${inv.keep}); the player box was renamed or moved.`
  );

  await sleep(2000);
  const media = await page.probe(() => __ytsb.media());
  const playing = media.filter((m) => !m.paused);
  check(
    'paused',
    media.length === 0 ? 'warn' : playing.length === 0,
    media.length === 0
      ? 'No <video> found on the Short page; cannot tell whether pausing works.'
      : playing.length
        ? `Video still playing at: ${playing.map((m) => m.where).join(' | ')}. content.js pauses "ytd-shorts video, shorts-video video" and any media that fires play while blocked.`
        : `${media.length} media element(s), all paused`
  );

  const leaks = await page.probe(
    (r, k, i, pre) => __ytsb.shortLeaks(r, k, i, pre),
    cfg.roots[s.device],
    inv.keep,
    cfg.ignoreInShorts[s.device] || '',
    s.device === 'desktop' ? `.ytsb-blocked ${cfg.roots.desktop}` : '.ytsb-blocked'
  );
  res.leaks.push(...leaks.map((l) => ({ ...l, area: `short-${s.device}` })));
  const rootFound = await page.probe((r) => !!document.querySelector(r), cfg.roots[s.device]);
  check(
    'no-leaks',
    rootFound ? leaks.length === 0 : false,
    !rootFound
      ? `Leak search root "${cfg.roots[s.device]}" (maintain/config.json roots.${s.device}) is missing from the page.`
      : leaks.length
        ? `${leaks.length} visible element(s) on the blocked Short: ${leaks.map((l) => l.element).join(', ')}`
        : 'nothing visible except the block screen'
  );

  const before = page.url();
  if (s.device === 'desktop') {
    await page.mouse.move(640, 400);
    await page.mouse.wheel({ deltaY: 600 });
    await sleep(700);
    await page.mouse.wheel({ deltaY: 600 });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('PageDown');
  } else {
    await page.touchscreen.touchStart(200, 650);
    for (let i = 1; i <= 8; i++) await page.touchscreen.touchMove(200, 650 - i * 60);
    await page.touchscreen.touchEnd();
  }
  await sleep(2500);
  const after = page.url();
  const stillPaused = (await page.probe(() => __ytsb.media())).every((m) => m.paused);
  check(
    'inputs',
    after === before && stillPaused,
    after !== before
      ? `${s.device === 'desktop' ? 'Wheel/ArrowDown/PageDown' : 'A touch swipe'} moved to another Short (${new URL(before).pathname} -> ${new URL(after).pathname}). YouTube may navigate through an input path content.js does not swallow.`
      : stillPaused
        ? 'wheel/keys/swipe did not change the Short'
        : 'URL unchanged but a video started playing after input'
  );
}

async function runFeed(s, page, check, res, { inv, cfg }, html) {
  const isControl = s.kind === 'control';
  if (isControl) {
    check('gate-off', !html.includes('ytsb-hide-feeds'), html.includes('ytsb-hide-feeds') ? 'hide_shorts_in_feeds: false did not remove ytsb-hide-feeds.' : 'feeds shown when the policy says so');
  } else {
    check('not-blocked', !html.includes('ytsb-blocked'), html.includes('ytsb-blocked') ? `ytsb-blocked is set on a non-Short page (${page.url()}).` : 'not blocked');
  }
  const stop = s.device === 'desktop' ? 'ytd-app' : 'ytm-app';
  for (const w of s.device === 'desktop' && s.widths ? s.widths : [null]) {
    if (w && w !== s.widths[0]) {
      await page.setViewport({ width: w, height: 800 });
      await sleep(1500);
    }
    const leaks = await page.probe((i, st, pre) => __ytsb.labelLeaks(i, st, pre), cfg.allowedShortsLabels, stop, isControl ? '' : '.ytsb-hide-feeds');
    const id = w ? `@${w}px` : '';
    if (isControl) {
      check(
        `detector${id}`,
        leaks.length ? true : 'warn',
        leaks.length
          ? `positive control: ${leaks.length} Shorts element(s) seen with feeds shown`
          : 'With feeds shown, the leak detector saw no Shorts links or labels. Either this page has none today, or YouTube changed how Shorts are linked/labelled and leaks would go unnoticed.'
      );
    } else {
      res.leaks.push(...leaks.map((l) => ({ ...l, area: 'feed', width: w })));
      check(
        `no-shorts-visible${id}`,
        leaks.length === 0,
        leaks.length ? `${leaks.length} visible Shorts element(s): ${leaks.map((l) => l.element).join(', ')}` : 'no Shorts links or labels visible'
      );
    }
  }
  if (!s.spa) return;

  await page.probe(() => __ytsb.clearEvents());
  const href = await page.probe(() => __ytsb.clickShort());
  if (!href) {
    const links = await page.probe(() => __ytsb.shortLinks());
    check('spa-link', 'warn', `No a[href^="/shorts/"] link on the page to test in-app navigation. Short-like links: ${links.join(', ') || 'none'}. If Shorts links changed form, isShortsPath in content.js may need updating.`);
    return;
  }
  await waitFor(async () => (await page.probe(() => __ytsb.htmlClass())).includes('ytsb-blocked'), 6000);
  await sleep(1500);
  const html2 = await page.probe(() => __ytsb.htmlClass());
  const events = await page.probe(() => __ytsb.events());
  const blocked = html2.includes('ytsb-blocked');
  const listened = inv.events.map((e) => `${e.target}:${e.name}`).join(', ');
  check(
    'spa-block',
    blocked,
    blocked
      ? `in-app navigation to ${href} blocked`
      : `In-app navigation to ${href} (now ${new URL(page.url()).pathname}) did not set ytsb-blocked. content.js listens for ${listened}.`,
    blocked ? null : { eventsSeen: summariseEvents(events), bodyClass: await page.probe(() => __ytsb.bodyClass()) }
  );
  if (blocked) {
    const media = await page.probe(() => __ytsb.media());
    const playing = media.filter((m) => !m.paused);
    check('spa-paused', playing.length === 0, playing.length ? `Video playing after in-app navigation: ${playing.map((m) => m.where).join(' | ')}` : 'paused');
  }
  await page.probe(() => __ytsb.clearEvents());
  // The Shorts player can add its own history entry, so Back may need
  // pressing twice to leave; what matters is that the class follows the page.
  for (let i = 0; i < 2; i++) {
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(2500);
    if (!inv.isShortsPath(new URL(page.url()).pathname)) break;
  }
  const backPath = new URL(page.url()).pathname;
  if (inv.isShortsPath(backPath)) {
    check('spa-unblock', 'warn', `Back did not leave the Short (still at ${backPath}); unblocking was not tested.`);
    return;
  }
  await waitFor(async () => !(await page.probe(() => __ytsb.htmlClass())).includes('ytsb-blocked'), 6000);
  const html3 = await page.probe(() => __ytsb.htmlClass());
  const unblocked = !html3.includes('ytsb-blocked');
  check(
    'spa-unblock',
    unblocked,
    unblocked ? 'Back to the feed unblocked' : `After Back to ${page.url()}, ytsb-blocked is still set. content.js listens for ${listened}.`,
    unblocked ? null : { eventsSeen: summariseEvents(await page.probe(() => __ytsb.events())) }
  );
}

async function runRedirect(s, page, check) {
  const target = 'example.com';
  const host = () => new URL(page.url()).host;
  if (!s.spa) {
    const ok = await waitFor(async () => host() === target, 8000);
    check('redirect', ok, ok ? 'cold load redirected' : `A cold load of a Short with redirect: true stayed on ${page.url()}.`);
    return;
  }
  const searchUrl = page.url();
  const href = await page.probe(() => __ytsb.clickShort());
  if (!href) {
    check('redirect-spa', 'warn', 'No Shorts link found on the search page to test an in-app redirect.');
    return;
  }
  const ok = await waitFor(async () => host() === target, 8000);
  check('redirect-spa', ok, ok ? 'click from search redirected' : `Clicking ${href} from search with redirect: true ended on ${page.url()}.`);
  if (!ok) return;
  await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(2000);
  const back = page.url();
  const backOk = new URL(back).pathname === new URL(searchUrl).pathname;
  check('redirect-back', backOk, backOk ? 'Back returned to search' : `Back after the redirect went to ${back}, expected the search page.`);
}

// Opens a scenario's page for `try` and `outline`, with leaks marked so an
// outline can be rooted at [data-ytsb-leak-ctx="0"].
export async function openScenario(s, { inv, cfg, newPage }) {
  const page = await newPage(s.device);
  if (s.widths && s.device === 'desktop') await page.setViewport({ width: s.widths[0], height: 800 });
  await page.goto(s.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await waitReady(page, s, cfg);
  if (s.kind === 'short') {
    await page.probe((r, k, i) => __ytsb.shortLeaks(r, k, i, ''), cfg.roots[s.device], inv.keep, cfg.ignoreInShorts[s.device] || '');
  } else {
    await page.probe((i, st) => __ytsb.labelLeaks(i, st, ''), cfg.allowedShortsLabels, s.device === 'desktop' ? 'ytd-app' : 'ytm-app');
  }
  return page;
}
