// Simulates YouTube replacing the Shorts action bar element with a new tag:
// reel-action-bar-view-model becomes reel-action-bar-renderer-v2.
new MutationObserver(() => {
  for (const el of document.querySelectorAll('ytd-shorts reel-action-bar-view-model')) {
    const n = document.createElement('reel-action-bar-renderer-v2');
    for (const a of el.attributes) n.setAttribute(a.name, a.value);
    n.append(...el.childNodes);
    el.replaceWith(n);
  }
}).observe(document, { subtree: true, childList: true });
