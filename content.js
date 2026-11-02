'use strict';

// Everything visual is done by block.css, keyed off one class on <html>.
// This script only decides when that class applies, keeps the video paused,
// and swallows the inputs YouTube uses to move between Shorts.
(() => {
  const BLOCKED_CLASS = 'ytsb-blocked';
  const root = document.documentElement;
  let blocked = false;

  const isShortsPath = () => /^\/shorts(\/|$)/.test(location.pathname);

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
    const videos = document.querySelectorAll('ytd-shorts video');
    for (const v of videos) v.pause();
  };

  const setBlocked = (on) => {
    if (on === blocked) return;
    blocked = on;
    root.classList.toggle(BLOCKED_CLASS, on);
    if (on) {
      attachInputBlockers();
      pauseShorts();
    } else {
      detachInputBlockers();
    }
  };

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
  // block state has to follow its own navigation events. "start" fires before
  // the URL updates, hence reading pageType from the event rather than the
  // location; its detail is small, unlike the finish event's.
  document.addEventListener('yt-navigate-start', (e) => {
    const pageType = e.detail && e.detail.pageType;
    if (pageType) setBlocked(pageType === 'shorts');
  });
  document.addEventListener('yt-navigate-finish', () => setBlocked(isShortsPath()));

  setBlocked(isShortsPath());
})();
