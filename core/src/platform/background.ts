/**
 * Keep work going while the app is in the background (the user switched apps).
 * Android stops screen refreshes for a hidden page, and pdf.js renders pages in steps scheduled with
 * requestAnimationFrame, so page rendering (scans, exports) would barely move. While the page is hidden,
 * frame callbacks run at once instead (via a message port, which isn't throttled). Visible: unchanged.
 * The app itself has no animation loops on requestAnimationFrame, so this can't spin.
 */
export function keepWorkingWhenHidden(): void {
  const raf = window.requestAnimationFrame.bind(window);
  const mc = new MessageChannel();
  const pending = new Map<number, FrameRequestCallback>();
  let seq = 1;
  const run = (id: number) => { const cb = pending.get(id); if (cb) { pending.delete(id); cb(performance.now()); } };
  mc.port1.onmessage = (e: MessageEvent<number>) => run(e.data);
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = seq++;
    pending.set(id, cb);
    if (document.hidden) mc.port2.postMessage(id); else raf(() => run(id));
    return id;
  };
  window.cancelAnimationFrame = (id: number) => { pending.delete(id); };
  // Frames requested just before the page was hidden would otherwise wait until it's shown again.
  document.addEventListener('visibilitychange', () => { if (document.hidden) for (const id of pending.keys()) mc.port2.postMessage(id); });
}
