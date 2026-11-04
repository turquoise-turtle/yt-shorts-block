// Simulates YouTube renaming its desktop navigation events: yt-navigate-start
// and yt-navigate-finish are dispatched as yt-nav-begin and yt-nav-end.
(() => {
  const map = { 'yt-navigate-start': 'yt-nav-begin', 'yt-navigate-finish': 'yt-nav-end' };
  const orig = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (e) {
    if (map[e.type]) e = new CustomEvent(map[e.type], { bubbles: e.bubbles, detail: e.detail });
    return orig.call(this, e);
  };
})();
