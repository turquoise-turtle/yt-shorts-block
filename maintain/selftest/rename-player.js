// Simulates YouTube renaming the desktop player box: #player-container
// becomes #player-box inside ytd-shorts.
new MutationObserver(() => {
  for (const el of document.querySelectorAll('ytd-shorts #player-container')) el.id = 'player-box';
}).observe(document, { subtree: true, childList: true });
