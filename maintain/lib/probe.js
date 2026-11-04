// Injected into the page's main world. Everything the harness learns about the
// live DOM goes through window.__ytsb, so the Node side only ever receives small
// JSON summaries instead of raw HTML.
(() => {
  if (window.__ytsb) return;

  const stripPseudo = (sel) => sel.replace(/::?(before|after|marker|placeholder)\b/g, '');

  const safeAll = (sel, root = document) => {
    try {
      return [...root.querySelectorAll(stripPseudo(sel))];
    } catch {
      return null;
    }
  };

  const inViewport = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };

  const isVisible = (el) =>
    el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && inViewport(el);

  const ownText = (el) => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.replace(/\s+/g, ' ').trim();
  };

  const MEDIA = new Set(['IMG', 'VIDEO', 'CANVAS', 'PICTURE', 'svg', 'IFRAME']);
  const hasContent = (el) => {
    if (MEDIA.has(el.tagName)) return true;
    if (ownText(el)) return true;
    const bg = getComputedStyle(el).backgroundImage;
    return bg && bg !== 'none';
  };

  const cls = (el) =>
    [...el.classList].filter((c) => !c.startsWith('ytsb-') && !/^style-scope$/.test(c)).slice(0, 4);

  const describe = (el) => {
    if (!el || el.nodeType !== 1) return '';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    for (const c of cls(el)) s += '.' + c;
    for (const a of ['href', 'title', 'aria-label', 'tab-title', 'page-subtype', 'role']) {
      const v = el.getAttribute(a);
      if (v != null) s += `[${a}="${v.slice(0, 40)}"]`;
    }
    return s;
  };

  const path = (el, depth = 4) => {
    const out = [];
    for (let p = el.parentElement; p && out.length < depth && p !== document.documentElement; p = p.parentElement) {
      out.push(p.tagName.toLowerCase() + (p.id ? '#' + p.id : ''));
    }
    return out.reverse().join(' > ');
  };

  const fingerprint = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    cls: cls(el),
    attrs: [...el.attributes].map((a) => a.name).filter((n) => !['class', 'id', 'style'].includes(n) && !n.startsWith('data-ytsb')).slice(0, 10),
    parent: el.parentElement ? el.parentElement.tagName.toLowerCase() : '',
    kids: [...new Set([...el.children].map((c) => c.tagName.toLowerCase()))].slice(0, 8),
    text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
  });

  // Splits a selector into compounds and the combinators between them,
  // ignoring anything inside (), [] or quotes.
  const splitCompounds = (sel) => {
    const parts = [];
    const combs = [];
    let cur = '';
    let depth = 0;
    let quote = null;
    for (let i = 0; i < sel.length; i++) {
      const ch = sel[i];
      if (quote) {
        cur += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      if (ch === '(' || ch === '[') depth++;
      if (ch === ')' || ch === ']') depth--;
      if (depth === 0 && /[\s>+~]/.test(ch)) {
        let j = i;
        let comb = ' ';
        while (j < sel.length && /[\s>+~]/.test(sel[j])) {
          if (sel[j] !== ' ') comb = sel[j];
          j++;
        }
        if (cur) {
          parts.push(cur);
          combs.push(comb);
        }
        cur = '';
        i = j - 1;
        continue;
      }
      cur += ch;
    }
    if (cur) parts.push(cur);
    return { parts, combs: combs.slice(0, parts.length - 1) };
  };

  const join = ({ parts, combs }, n) => {
    let s = parts[0];
    for (let i = 1; i < n; i++) s += (combs[i - 1] === ' ' ? ' ' : ` ${combs[i - 1]} `) + parts[i];
    return s;
  };

  const jaccard = (a, b) => {
    if (!a.length && !b.length) return 1;
    const sa = new Set(a);
    const inter = b.filter((x) => sa.has(x)).length;
    return inter / (new Set([...a, ...b]).size || 1);
  };

  const score = (fp, el) => {
    const c = fingerprint(el);
    let s = 0;
    s += c.tag === fp.tag ? 0.3 : 0.25 * jaccard(c.tag.split('-'), fp.tag.split('-'));
    if (fp.id) s += c.id === fp.id ? 0.25 : 0;
    else s += c.id ? 0 : 0.1;
    s += 0.15 * jaccard(c.cls, fp.cls);
    s += 0.1 * jaccard(c.attrs, fp.attrs);
    s += c.parent === fp.parent ? 0.1 : 0;
    s += 0.05 * jaccard(c.kids, fp.kids);
    if (fp.text && c.text && c.text.slice(0, 15) === fp.text.slice(0, 15)) s += 0.05;
    return Math.round(s * 100) / 100;
  };

  const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);

  // Ways to write a single compound that selects el, most stable first.
  const compoundOptions = (el, fp) => {
    const tag = el.tagName.toLowerCase();
    const opts = [];
    if (tag.includes('-')) opts.push(tag);
    if (el.id) opts.push('#' + cssEsc(el.id));
    const shared = fp ? cls(el).filter((c) => fp.cls.includes(c)) : [];
    for (const c of [...shared, ...cls(el)]) opts.push(tag + '.' + cssEsc(c));
    for (const a of el.attributes) {
      if (!['class', 'id', 'style'].includes(a.name) && !a.name.startsWith('data-ytsb') && a.value.length < 30) opts.push(`${tag}[${a.name}]`);
    }
    if (!tag.includes('-')) opts.push(tag);
    return [...new Set(opts)];
  };

  // Marks a leak and its parent so `outline` can be rooted there later.
  const mark = (el, i) => {
    el.setAttribute('data-ytsb-leak', String(i));
    if (el.parentElement) el.parentElement.setAttribute('data-ytsb-leak-ctx', String(i));
  };

  // First selector, written under `prefix`, that matches el and passes the
  // caller's safety test.
  const suggest = (el, prefix, options, unsafe) => {
    for (const opt of options) {
      const sel = prefix ? `${prefix} ${opt}` : opt;
      const els = safeAll(sel);
      if (els && els.includes(el) && !unsafe(els)) return { selector: sel, matches: els.length };
    }
    const parent = el.parentElement;
    if (parent) {
      for (const p of compoundOptions(parent, null).slice(0, 3)) {
        for (const opt of options.slice(0, 3)) {
          const sel = `${prefix ? prefix + ' ' : ''}${p} > ${opt}`;
          const els = safeAll(sel);
          if (els && els.includes(el) && !unsafe(els)) return { selector: sel, matches: els.length };
        }
      }
    }
    return null;
  };

  const api = {
    url: () => location.href,
    htmlClass: () => document.documentElement.className,

    // Counts every selector; fingerprints are only gathered when asked, for
    // recording a baseline.
    count(selectors, withFingerprints = false) {
      const out = {};
      for (const sel of selectors) {
        const els = safeAll(sel);
        if (!els) {
          out[sel] = { n: -1 };
          continue;
        }
        const entry = { n: els.length };
        if (withFingerprints && els.length) {
          const split = splitCompounds(stripPseudo(sel));
          entry.fps = [];
          for (let i = 1; i <= split.parts.length; i++) {
            const first = safeAll(join(split, i))?.[0];
            entry.fps.push(first ? fingerprint(first) : null);
          }
        }
        out[sel] = entry;
      }
      return out;
    },

    // For a selector that no longer matches: which compound broke, and which
    // elements now look most like what it used to select.
    diagnose(sel, fps, keepSel) {
      const split = splitCompounds(stripPseudo(sel));
      let k = 0;
      for (let i = 1; i <= split.parts.length; i++) {
        const els = safeAll(join(split, i));
        if (!els || !els.length) {
          k = i - 1;
          break;
        }
        k = i;
      }
      if (k === split.parts.length) return { broken: null };
      const res = { broken: split.parts[k], index: k, context: k ? join(split, k) : '', candidates: [] };
      const fp = fps && fps[k];
      if (!fp) return res;

      const ctx = k ? safeAll(join(split, k)) : [document.documentElement];
      const comb = k ? split.combs[k - 1] : ' ';
      const pool = new Set();
      for (const c of ctx.slice(0, 20)) {
        let els;
        if (comb === '>') els = [...c.children];
        else if (comb === '+') els = c.nextElementSibling ? [c.nextElementSibling] : [];
        else if (comb === '~') els = c.parentElement ? [...c.parentElement.children] : [];
        else els = [...c.querySelectorAll('*')];
        for (const e of els.slice(0, 4000)) pool.add(e);
      }
      const keep = keepSel ? safeAll(keepSel) || [] : [];
      const ranked = [...pool]
        .map((el) => ({ el, s: score(fp, el) }))
        .filter((x) => x.s >= 0.35)
        .sort((a, b) => b.s - a.s)
        .slice(0, 5);
      const seen = new Set();
      for (const { el, s } of ranked) {
        for (const opt of compoundOptions(el, fp)) {
          const parts = [...split.parts];
          // Keep a trailing :has()/:not() condition; it describes what the
          // element contains, which a rename does not usually change.
          const cond = split.parts[k].search(/:(has|not)\(/);
          parts[k] = opt + (cond >= 0 ? split.parts[k].slice(cond) : '');
          const rewritten = join({ parts, combs: split.combs }, parts.length);
          if (seen.has(rewritten)) continue;
          seen.add(rewritten);
          const matches = safeAll(rewritten);
          if (!matches || !matches.length) continue;
          const unsafe = keep.some((kp) => matches.some((m) => m === kp || m.contains(kp)));
          res.candidates.push({
            score: s,
            element: describe(el),
            compound: parts[k],
            selector: rewritten,
            matches: matches.length,
            unsafe,
          });
          break;
        }
        if (res.candidates.length >= 3) break;
      }
      return res;
    },

    // Visible content inside `rootSel` that is not the block screen. Each leak
    // is reported at the highest ancestor that can be hidden without hiding
    // the block screen, which is what a new selector should target.
    shortLeaks(rootSel, keepSel, ignoreSel, prefix) {
      const roots = safeAll(rootSel) || [];
      const keeps = safeAll(keepSel) || [];
      const ignore = ignoreSel ? safeAll(ignoreSel) || [] : [];
      const isKeepOrAncestor = (el) => keeps.some((k) => el === k || el.contains(k));
      const insideKeep = (el) => keeps.some((k) => k !== el && k.contains(el));
      const leaks = new Map();
      for (const root of roots) {
        for (const el of root.querySelectorAll('*')) {
          if (isKeepOrAncestor(el) || insideKeep(el)) continue;
          if (ignore.some((i) => i === el || i.contains(el))) continue;
          if (!hasContent(el) || !isVisible(el)) continue;
          let top = el;
          while (
            top.parentElement &&
            top.parentElement !== root &&
            !isKeepOrAncestor(top.parentElement) &&
            root.contains(top.parentElement)
          ) {
            top = top.parentElement;
          }
          if (!leaks.has(top)) leaks.set(top, { el: top, sample: el });
        }
      }
      const unsafe = (els) => els.some((m) => isKeepOrAncestor(m));
      return [...leaks.values()].slice(0, 8).map(({ el, sample }, i) => {
        mark(el, i);
        return {
          element: describe(el),
          path: path(el, 3),
          sample: describe(sample) + (ownText(sample) ? ` "${ownText(sample).slice(0, 40)}"` : ''),
          suggest: suggest(el, prefix, compoundOptions(el, null), unsafe),
        };
      });
    },

    // Visible links to Shorts and visible "Shorts" labels outside the player:
    // shelves, tabs and sidebar entries that the feed rules should hide.
    labelLeaks(ignoreSel, stopSel, prefix) {
      const ignore = ignoreSel ? safeAll(ignoreSel) || [] : [];
      const stops = new Set(safeAll(stopSel) || []);
      const ignored = (el) => ignore.some((i) => i === el || i.contains(el));
      const videoLinks = (el) => [...el.querySelectorAll('a[href]')].filter((a) => /\/(watch|shorts)\b/.test(a.getAttribute('href')));
      const isShortLink = (a) => /\/shorts\//.test(a.getAttribute('href') || '');
      const found = new Map();

      const add = (kind, start, climb) => {
        let top = start;
        for (let p = top.parentElement; p && !stops.has(p) && p !== document.body && climb(p); p = p.parentElement) top = p;
        if (!found.has(top)) found.set(top, { kind, top, start });
      };

      for (const a of document.querySelectorAll('a[href*="/shorts"]')) {
        if (ignored(a) || !isVisible(a)) continue;
        add('link', a, (p) => {
          const links = videoLinks(p);
          return links.length > 0 && links.every(isShortLink);
        });
      }
      for (const el of document.querySelectorAll('body *')) {
        if (ownText(el) !== 'Shorts' || ignored(el) || !isVisible(el)) continue;
        if ([...found.values()].some((f) => f.top.contains(el))) continue;
        const text = (el.textContent || '').trim();
        add('label', el, (p) => (p.textContent || '').replace(/\s+/g, ' ').trim() === text);
      }
      // A feed selector is safe only if everything it matches is purely
      // Shorts: a Shorts label, or a box whose video links all go to Shorts.
      const shortsOnly = (m) => {
        const links = videoLinks(m);
        if (links.length) return links.every(isShortLink);
        if ((m.textContent || '').trim() === 'Shorts') return true;
        return ['title', 'tab-title', 'aria-label'].some((a) => m.getAttribute(a) === 'Shorts');
      };
      const unsafe = (els) => els.length > 60 || !els.every(shortsOnly);
      return [...found.values()].slice(0, 10).map(({ kind, top, start }, i) => {
        mark(top, i);
        const tag = top.tagName.toLowerCase();
        const extra = [];
        for (const a of top.attributes) if (a.value === 'Shorts') extra.push(`${tag}[${a.name}="Shorts"]`);
        if (kind === 'link') extra.push(`${tag}:has(a[href^="/shorts/"])`);
        else extra.push(`${tag}:has([title="Shorts"])`);
        return {
          kind,
          element: describe(top),
          path: path(top, 4),
          sample: describe(start),
          suggest: suggest(top, prefix, [...compoundOptions(top, null), ...extra], unsafe),
        };
      });
    },

    // A compact, de-obfuscated view of a subtree for an LLM to reason about:
    // one line per element, repeated siblings collapsed, SVG and scripts left
    // out, and each line flagged with whether it is visible.
    outline(rootSel, maxLines = 400, maxDepth = 30) {
      const root = (safeAll(rootSel) || [])[0];
      if (!root) return `(no element matches ${rootSel})`;
      const lines = [];
      const sig = (el) => el.tagName + '|' + el.id + '|' + cls(el).join('.') + '|' + el.children.length;
      const walk = (el, depth) => {
        if (lines.length >= maxLines || depth > maxDepth) return;
        if (['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META'].includes(el.tagName)) return;
        const vis = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        const r = el.getBoundingClientRect();
        const t = ownText(el);
        lines.push(
          '  '.repeat(depth) +
            describe(el) +
            (t ? ` "${t.slice(0, 50)}"` : '') +
            (vis ? ` (${Math.round(r.width)}x${Math.round(r.height)})` : ' (hidden)')
        );
        if (el.tagName === 'svg') return;
        const kids = [...el.children];
        for (let i = 0; i < kids.length; i++) {
          let j = i;
          while (j + 1 < kids.length && sig(kids[j + 1]) === sig(kids[i])) j++;
          walk(kids[i], depth + 1);
          if (j > i) {
            lines.push('  '.repeat(depth + 1) + `... ${j - i} more like the one above`);
            i = j;
          }
        }
      };
      walk(root, 0);
      if (lines.length >= maxLines) lines.push(`... truncated at ${maxLines} lines`);
      return lines.join('\n');
    },

    // Summary of what a selector would hide, for the `try` command.
    tryOut(sel, keepSel) {
      const els = safeAll(sel);
      if (!els) return { error: 'invalid selector' };
      const keeps = keepSel ? safeAll(keepSel) || [] : [];
      return {
        matches: els.length,
        visible: els.filter(isVisible).length,
        unsafe: keeps.some((k) => els.some((m) => m === k || m.contains(k))),
        ordinary: els.filter((m) => m.querySelector('a[href^="/watch"]')).length,
        sample: els.slice(0, 5).map((e) => describe(e) + '  in ' + path(e, 3)),
      };
    },

    media() {
      return [...document.querySelectorAll('video, audio')].map((v) => ({
        paused: v.paused,
        time: Math.round(v.currentTime * 10) / 10,
        where: path(v, 4),
      }));
    },

    pseudoContent(sel) {
      const el = (safeAll(sel) || [])[0];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        after: getComputedStyle(el, '::after').content,
        w: Math.round(r.width),
        h: Math.round(r.height),
        visible: isVisible(el),
      };
    },

    shortLinks() {
      return [...document.querySelectorAll('a[href]')]
        .map((a) => a.getAttribute('href'))
        .filter((h) => /shorts|reel/i.test(h))
        .slice(0, 5);
    },

    // Clicks the first Short link even if the feed rules hide it: YouTube's
    // own click handler still performs its in-app navigation.
    clickShort() {
      const a = [...document.querySelectorAll('a[href^="/shorts/"]')][0];
      if (!a) return null;
      a.click();
      return a.getAttribute('href');
    },

    events: () => (window.__ytsbEvents || []).slice(-60),
    // Emptied in place: the dispatch hook holds a reference to this array.
    clearEvents: () => {
      if (window.__ytsbEvents) window.__ytsbEvents.length = 0;
    },
    bodyClass: () => document.body && document.body.className,
    isBotWall: () =>
      /consent\./.test(location.host) ||
      /not a bot|unusual traffic|before you continue/i.test((document.body && document.body.innerText.slice(0, 3000)) || ''),
  };

  window.__ytsb = api;
})();
