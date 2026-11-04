// Launches headless Chrome with a staged copy of the extension. Policy
// variants get a small shim in front of content.js, because managed policy
// cannot be set on a developer machine without admin rights.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { ROOT, EXT_FILES } from './inventory.mjs';

export const HARNESS = path.join(ROOT, 'maintain');
export const OUT = path.join(HARNESS, 'out');

export const VARIANTS = {
  default: null,
  redirect: { redirect: true, redirect_url: 'https://example.com/' },
  'feeds-off': { hide_shorts_in_feeds: false },
};

export async function loadPuppeteer() {
  try {
    return await import('puppeteer');
  } catch {
    console.error('Installing harness dependencies (first run only)...');
    // npm is a .cmd shim on Windows, which execFile can only start through a shell.
    execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: HARNESS, stdio: 'inherit', shell: process.platform === 'win32' });
    return await import('puppeteer');
  }
}

// Every run tests against the newest stable Chrome for Testing, not the
// version puppeteer happens to pin, because students get Chrome updates
// automatically and YouTube serves markup by browser version.
let chromePromise;
export function ensureChrome() {
  chromePromise ||= (async () => {
    if (process.env.CHROME_PATH) return { executablePath: process.env.CHROME_PATH, buildId: 'CHROME_PATH' };
    const b = await import('@puppeteer/browsers');
    const cacheDir = process.env.PUPPETEER_CACHE_DIR || path.join(os.homedir(), '.cache', 'puppeteer');
    const platform = b.detectBrowserPlatform();
    let buildId;
    let note = '';
    try {
      buildId = await b.resolveBuildId(b.Browser.CHROME, platform, b.BrowserTag.STABLE);
    } catch (e) {
      const cached = (await b.getInstalledBrowsers({ cacheDir })).filter((x) => x.browser === b.Browser.CHROME);
      if (!cached.length) throw new Error(`Cannot look up the latest Chrome (${e.message}) and none is cached.`);
      buildId = cached.map((x) => x.buildId).sort((x, y) => y.localeCompare(x, undefined, { numeric: true }))[0];
      note = ' (offline: newest cached build, may not be the latest)';
    }
    const executablePath = b.computeExecutablePath({ browser: b.Browser.CHROME, buildId, cacheDir });
    if (!fs.existsSync(executablePath)) {
      console.error(`Downloading Chrome for Testing ${buildId}...`);
      await b.install({ browser: b.Browser.CHROME, buildId, cacheDir });
    }
    return { executablePath, buildId: buildId + note };
  })();
  return chromePromise;
}

export function stage(variant) {
  const dir = path.join(OUT, 'ext', variant);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of EXT_FILES) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.cpSync(path.join(ROOT, 'icons'), path.join(dir, 'icons'), { recursive: true });
  const policy = VARIANTS[variant];
  if (policy) {
    fs.writeFileSync(
      path.join(dir, 'policy-shim.js'),
      `{ const policy = ${JSON.stringify(policy)};\n` +
        `  Object.defineProperty(chrome.storage.managed, 'get', { value: () => Promise.resolve(policy) }); }\n`
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    for (const cs of manifest.content_scripts) cs.js = ['policy-shim.js', ...cs.js];
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  return dir;
}

// Records YouTube's own events on document and window, so a broken
// navigation hook can be matched to whatever the site dispatches now.
const EVENT_HOOK = `(() => {
  const log = (window.__ytsbEvents = []);
  const orig = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (e) {
    try {
      // YouTube dispatches its navigation events on ytd-app and lets them
      // bubble, so anything that can reach document or window counts.
      const reaches = this === document || this === window || (e.bubbles && this instanceof Node && this.isConnected);
      if (reaches && !e.isTrusted && e instanceof CustomEvent && !/^(yt-action|yt-service-request|yt-load-reload-continuation|iron-.+|dom-change|yt-rendererstamper-finished|yt-live-chat-.+)$/.test(e.type)) {
        const d = e.detail;
        const pageType = d && typeof d === 'object' && 'pageType' in d ? String(d.pageType) : undefined;
        const on = this === window ? 'window' : this === document ? 'document' : this.nodeName.toLowerCase();
        log.push({ type: e.type, on, pageType, path: location.pathname });
        if (log.length > 400) log.splice(0, 200);
      }
    } catch {}
    return orig.call(this, e);
  };
})();`;

export async function launch(variant, { simulate } = {}) {
  const puppeteer = await loadPuppeteer();
  const { executablePath, buildId } = await ensureChrome();
  const ext = stage(variant);
  const browser = await puppeteer.default.launch({
    headless: process.env.HEADFUL ? false : true,
    pipe: true,
    executablePath,
    enableExtensions: [ext],
    args: ['--autoplay-policy=no-user-gesture-required', '--lang=en-US', '--mute-audio'],
  });
  const probe = fs.readFileSync(path.join(HARNESS, 'lib', 'probe.js'), 'utf8');
  const sim = simulate ? fs.readFileSync(path.join(HARNESS, 'selftest', `${simulate}.js`), 'utf8') : null;

  const newPage = async (device) => {
    const page = await browser.newPage();
    if (device === 'mobile') await page.emulate(puppeteer.KnownDevices['Pixel 5']);
    else await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.evaluateOnNewDocument(EVENT_HOOK);
    if (sim) await page.evaluateOnNewDocument(sim);
    page.probe = async (fn, ...args) => {
      await page.evaluate(probe);
      return page.evaluate(fn, ...args);
    };
    return page;
  };
  return { browser, newPage, chrome: buildId };
}
