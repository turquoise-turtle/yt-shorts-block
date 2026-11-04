// Simulates YouTube moving Shorts to /reel/<id>: the address bar is
// rewritten once a Short has loaded.
setInterval(() => {
  if (/^\/shorts\//.test(location.pathname)) history.replaceState(history.state, '', location.href.replace('/shorts/', '/reel/'));
}, 200);
