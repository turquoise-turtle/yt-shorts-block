'use strict';

// Everything visual is done by block.css, keyed off classes on <html>.
// This script only decides when those classes apply, keeps the video paused,
// swallows the inputs YouTube uses to move between Shorts, and redirects when
// an administrator has asked for that.
(() => {
  const BLOCKED_CLASS = 'ytsb-blocked';
  const HIDE_FEEDS_CLASS = 'ytsb-hide-feeds';
  const HOME_CLASS = 'ytsb-home';
  const root = document.documentElement;
  let blocked = false;

  const DEFAULT_REDIRECT_URL = 'https://youtube.com';
  let settings = { redirect: false, redirectUrl: DEFAULT_REDIRECT_URL, hideFeeds: true };

  // Storage reads are asynchronous, so the default (hide Shorts shelves) is
  // applied up front to avoid a flash of Shorts before the settings arrive.
  root.classList.add(HIDE_FEEDS_CLASS);

  const isShortsPath = (path = location.pathname) => /^\/shorts(\/|$)/.test(path);

  const isEditable = (el) =>
    el instanceof HTMLElement &&
    (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');

  // Keys YouTube maps to previous/next Short. Space is left alone because the
  // play listener below re-pauses anything it starts.
  const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

  const swallow = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const onKeydown = (e) => {
    if (NAV_KEYS.has(e.key) && !isEditable(e.target)) swallow(e);
  };

  // Non-passive wheel/touch listeners force every scroll through the main
  // thread, so they are only attached while a Short is actually blocked.
  const INPUT_OPTS = { capture: true, passive: false };
  const attachInputBlockers = () => {
    window.addEventListener('wheel', swallow, INPUT_OPTS);
    window.addEventListener('touchmove', swallow, INPUT_OPTS);
    window.addEventListener('keydown', onKeydown, true);
  };
  const detachInputBlockers = () => {
    window.removeEventListener('wheel', swallow, INPUT_OPTS);
    window.removeEventListener('touchmove', swallow, INPUT_OPTS);
    window.removeEventListener('keydown', onKeydown, true);
  };

  const pauseShorts = () => {
    const videos = document.querySelectorAll('ytd-shorts video, shorts-video video');
    for (const v of videos) v.pause();
  };

  // Replace the history entry when it is the Short itself, so Back does not
  // bounce into the redirect again; otherwise (desktop navigation starts
  // before the URL changes) keep the page the student came from.
  const maybeRedirect = () => {
    if (!blocked || !settings.redirect) return;
    if (isShortsPath()) location.replace(settings.redirectUrl);
    else location.assign(settings.redirectUrl);
  };

  const setBlocked = (on) => {
    if (on === blocked) return;
    blocked = on;
    root.classList.toggle(BLOCKED_CLASS, on);
    if (on) {
      attachInputBlockers();
      pauseShorts();
      maybeRedirect();
    } else {
      detachInputBlockers();
    }
  };

  // Only http(s) targets are accepted, and never a Short, which would loop.
  const parseRedirectUrl = (value) => {
    try {
      const url = new URL(value);
      const isHttp = url.protocol === 'https:' || url.protocol === 'http:';
      const isShort = /(^|\.)youtube\.com$/.test(url.hostname) && isShortsPath(url.pathname);
      if (isHttp && !isShort) return url.href;
    } catch {}
    return DEFAULT_REDIRECT_URL;
  };

  // Every setting comes only from managed policy (managed_schema.json), so
  // students have nothing to change. Unset or invalid values keep the defaults.
  const loadSettings = async () => {
    let managed = {};
    try {
      managed = await chrome.storage.managed.get(null);
    } catch {}
    settings = {
      redirect: managed.redirect === true,
      redirectUrl: parseRedirectUrl(managed.redirect_url ?? DEFAULT_REDIRECT_URL),
      hideFeeds: managed.hide_shorts_in_feeds !== false,
    };
    root.classList.toggle(HIDE_FEEDS_CLASS, settings.hideFeeds);
    maybeRedirect();
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'managed') loadSettings();
  });
  loadSettings();

  // Media "play" does not bubble, but it still passes through the capture
  // phase, so one listener covers every player YouTube ever creates. CSS hides
  // the picture; this is what stops the sound.
  document.addEventListener(
    'play',
    (e) => {
      if (blocked && e.target instanceof HTMLMediaElement) e.target.pause();
    },
    true
  );

  // YouTube is a single-page app: the URL changes without a page load, so the
  // block state has to follow its own navigation events.
  // The home class only scopes the mobile feed rules: unlike the desktop app,
  // the mobile app marks nothing in the page as being the home page.
  const syncWithLocation = () => {
    root.classList.toggle(HOME_CLASS, location.pathname === '/');
    setBlocked(isShortsPath());
  };

  // www.youtube.com: "start" fires before the URL updates, hence reading
  // pageType from the event rather than the location; its detail is small,
  // unlike the finish event's, which is never read.
  document.addEventListener('yt-navigate-start', (e) => {
    const pageType = e.detail && e.detail.pageType;
    if (pageType) setBlocked(pageType === 'shorts');
  });
  document.addEventListener('yt-navigate-finish', syncWithLocation);

  // m.youtube.com is a different app with its own events, dispatched on
  // window: "state-change" fires as soon as the URL has changed and
  // "state-navigateend" once the page has rendered.
  window.addEventListener('state-change', syncWithLocation);
  window.addEventListener('state-navigateend', syncWithLocation);

  // Safety net for the mobile app, whose event names are undocumented: it
  // swaps a page-* class on <body> for every page it renders, and watching
  // that one attribute costs nothing between navigations.
  const watchBodyClass = () =>
    new MutationObserver(syncWithLocation).observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
    });
  if (document.body) watchBodyClass();
  else document.addEventListener('DOMContentLoaded', watchBodyClass, { once: true });

  syncWithLocation();
})();
