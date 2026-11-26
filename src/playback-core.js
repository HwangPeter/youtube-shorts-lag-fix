// Keep playback speed and quality across the lag fix's reload: the logic, with
// no DOM or browser access, shared by the page script (src/playback.js), the
// content script that reloads (src/refresh.js) and the unit tests
// (test/playback-core.test.mjs). A plain script: it defines one global,
// YtPlaybackCore.
//
// Why: a fresh YouTube page starts at normal speed, and does not always come
// back at the quality picked in the player's menu. So just before the add-on
// reloads YouTube (every N videos, or "Start fresh session now"), it saves
// the player's speed and its chosen quality, and once the new page's player
// is ready it sets them again, once. Quality left on Auto stays on Auto.
//
// player: YouTube's player element (#movie_player or #shorts-player), whose
// methods only the page's own world can call.
var YtPlaybackCore = (() => {
  'use strict';
  // Fired on document by refresh.js just before it reloads: the page script
  // saves the playback settings when it hears it.
  const SAVE_EVENT = 'yt-shorts-fix-save-playback';
  // sessionStorage key: per tab, and kept over a same-tab reload.
  const STORAGE_KEY = 'ytShortsFixPlayback';
  // A saved entry older than this is ignored: it is meant only for the
  // reload that follows it at once.
  const MAX_AGE_MS = 60000;
  const MIN_RATE = 0.0625;
  const MAX_RATE = 16;
  // YouTube's quality names, as getPreferredQuality() and
  // setPlaybackQualityRange() use them ('auto' is not one to restore).
  const QUALITY = /^(tiny|small|medium|large|hd\d+|highres)$/;

  const call = (player, method, ...args) => {
    try { return typeof player?.[method] === 'function' ? player[method](...args) : undefined; } catch (e) { return undefined; }
  };
  const validRate = (r) => typeof r === 'number' && Number.isFinite(r) && r >= MIN_RATE && r <= MAX_RATE;
  const validQuality = (q) => typeof q === 'string' && QUALITY.test(q);

  // The player for a page: the Shorts player on /shorts/ pages, else the
  // watch page's player (both elements can exist at once).
  const playerSelector = (href) => {
    let path = '';
    try { path = new URL(href).pathname; } catch (e) { /* not a URL */ }
    return path.startsWith('/shorts/') ? '#shorts-player' : '#movie_player';
  };

  const videoOf = (player) => {
    const id = call(player, 'getVideoData')?.video_id;
    return typeof id === 'string' && id ? id : null;
  };

  // What to keep: { at, video, rate, quality }, with quality only when the
  // user chose one (not Auto), or null when there is nothing to keep. video
  // is the player's video, so the settings go back on that video only.
  const capture = (player, now) => {
    const video = videoOf(player);
    if (!video) return null;
    const out = { at: now, video };
    const rate = call(player, 'getPlaybackRate');
    if (validRate(rate)) out.rate = rate;
    const quality = call(player, 'getPreferredQuality');
    if (validQuality(quality)) out.quality = quality;
    return 'rate' in out || 'quality' in out ? out : null;
  };

  // The saved entry (a JSON string, or null) as { video, rate?, quality? },
  // or null when it is missing, malformed or too old.
  const parse = (raw, now) => {
    if (typeof raw !== 'string') return null;
    let o;
    try { o = JSON.parse(raw); } catch (e) { return null; }
    if (!o || typeof o !== 'object' || typeof o.at !== 'number' || !(now - o.at >= 0 && now - o.at <= MAX_AGE_MS)) return null;
    if (typeof o.video !== 'string' || !o.video) return null;
    const out = { video: o.video };
    if (validRate(o.rate)) out.rate = o.rate;
    if (validQuality(o.quality)) out.quality = o.quality;
    return 'rate' in out || 'quality' in out ? out : null;
  };

  // Whether the new page's player is ready for the saved settings: it has
  // the saved video loaded, and no ad is showing (an ad has its own speed).
  const ready = (player, saved) => {
    if (!player || !saved?.video || player.classList?.contains('ad-showing')) return false;
    if (videoOf(player) !== saved.video) return false;
    const levels = call(player, 'getAvailableQualityLevels');
    return Array.isArray(levels) && levels.length > 0;
  };

  // Sets the saved settings on the player, each only if it differs. The
  // quality is set as the preference even when this video does not have it,
  // as YouTube keeps it: the video then plays at the nearest quality it has,
  // and later videos at the chosen one. Returns what was set.
  const apply = (player, saved) => {
    const done = {};
    if (saved?.rate !== undefined && call(player, 'getPlaybackRate') !== saved.rate) {
      call(player, 'setPlaybackRate', saved.rate);
      done.rate = saved.rate;
    }
    if (saved?.quality !== undefined && call(player, 'getPreferredQuality') !== saved.quality) {
      call(player, 'setPlaybackQualityRange', saved.quality, saved.quality);
      done.quality = saved.quality;
    }
    return done;
  };

  return { SAVE_EVENT, STORAGE_KEY, MAX_AGE_MS, playerSelector, capture, parse, ready, apply };
})();
