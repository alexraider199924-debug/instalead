// This document is not a tab, so Chrome does not apply background-tab timer
// throttling to it. Pinging the service worker on a short interval keeps the
// worker from being suspended while a campaign is mid-flight — which is what
// used to stall sending when the browser was minimized.
setInterval(() => {
  chrome.runtime.sendMessage({ type: 'KEEP_ALIVE_PING' }).catch(() => {});
}, 20000);

// Handle delay requests from content scripts. Background tabs have throttled
// timers, but offscreen timers are never throttled. When a tab needs to wait,
// it sends a DELAY_REQUEST, offscreen waits in its unthrottled context, then
// responds so the tab can continue.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'DELAY_REQUEST') {
    const ms = msg.ms || 0;
    setTimeout(() => {
      sendResponse({ ok: true });
    }, ms);
    return true;
  }
});
