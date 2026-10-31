// Installs the offline service worker. An update waits until no document is open, then reloads the app.
if ('serviceWorker' in navigator) {
  const apply = (w) => {
    const go = () => { if (document.body.classList.contains('has-doc')) return false; w.postMessage('skipWaiting'); return true; };
    if (go()) return;
    const o = new MutationObserver(() => { if (go()) o.disconnect(); });
    o.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  };
  let reloading = false;
  const hadController = !!navigator.serviceWorker.controller; // false on the first visit: nothing to reload then
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // An update took over (only ever with no document open): run the new version.
    if (reloading || !hadController || document.body.classList.contains('has-doc')) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js', { scope: './' }).then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) apply(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) apply(w); });
    });
    // Home Screen apps stay open for days: look for updates when brought back to the front.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
  // Ask the browser not to clear the offline copy when storage runs low.
  navigator.storage?.persist?.().catch(() => {});
}
