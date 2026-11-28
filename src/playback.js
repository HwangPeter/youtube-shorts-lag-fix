// Keeps playback speed and quality across the lag fix's reload. Runs in the
// page's own world, after playback-core.js, because only that world can call
// YouTube's player methods. See playback-core.js for what it does and why.
//
// It acts only around the add-on's own reload:
// - Save: when refresh.js fires SAVE_EVENT on document just before it
//   reloads, it writes the player's speed and chosen quality to this tab's
//   sessionStorage.
// - Restore: on the page load that follows, it reads that entry, removes it
//   at once (so a later reload of any kind is unaffected), waits for the
//   player to have the same video loaded with no ad showing, and sets the
//   speed and quality once. A plain reload leaves no entry, so nothing runs.
(() => {
  'use strict';
  const core = globalThis.YtPlaybackCore;
  if (!core || globalThis.__ytShortsFixPlaybackLoaded) return;
  globalThis.__ytShortsFixPlaybackLoaded = true;

  const POLL_MS = 250;
  const GIVE_UP_MS = 60000; // long enough for pre-roll ads

  const player = () => document.querySelector(core.playerSelector(location.href));

  document.addEventListener(core.SAVE_EVENT, (e) => {
    const saved = core.capture(player(), Date.now(), e.detail);
    try {
      if (saved) sessionStorage.setItem(core.STORAGE_KEY, JSON.stringify(saved));
      else sessionStorage.removeItem(core.STORAGE_KEY);
    } catch (e) { /* storage unavailable: the reload just uses YouTube's defaults */ }
  });

  let raw = null;
  try {
    raw = sessionStorage.getItem(core.STORAGE_KEY);
    if (raw !== null) sessionStorage.removeItem(core.STORAGE_KEY);
  } catch (e) { return; }
  const saved = core.parse(raw, Date.now());
  if (!saved) return;
  const started = Date.now();
  const timer = setInterval(() => {
    const p = player();
    if (core.ready(p, saved)) {
      clearInterval(timer);
      const done = core.apply(p, saved);
      console.info('[shorts-fix] kept playback settings over the reload:', JSON.stringify(done));
    } else if (Date.now() - started > GIVE_UP_MS) {
      clearInterval(timer);
    }
  }, POLL_MS);
})();
