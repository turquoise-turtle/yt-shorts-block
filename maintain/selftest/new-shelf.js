// Simulates a new Shorts shelf element on desktop search results:
// grid-shelf-view-model becomes shorts-grid-shelf.
new MutationObserver(() => {
  for (const el of document.querySelectorAll('ytd-search grid-shelf-view-model')) {
    const n = document.createElement('shorts-grid-shelf');
    for (const a of el.attributes) n.setAttribute(a.name, a.value);
    n.style.display = 'block';
    n.append(...el.childNodes);
    el.replaceWith(n);
  }
}).observe(document, { subtree: true, childList: true });
