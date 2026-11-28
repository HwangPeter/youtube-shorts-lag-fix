// End-to-end test of the refresh-every-N-videos feature in a real Firefox.
//
//   npm run test:refresh            (builds, then runs this)
//   node test/refresh-e2e.mjs [--out DIR] [--only button]
//   env: FF_BIDI_PORT (default 9558), FIREFOX_BIN, SHORTS_CHANNEL
//
// Same launch rules as test/repro.mjs: a brand-new throwaway profile (deleted
// afterwards), muted with media.volume_scale=0.0, a visible window driven over
// WebDriver BiDi; under WSL it drives the Windows Firefox. It loads a copy of
// dist/extension with one test-only addition: a background script that opens
// the settings popup page (popup.html, unchanged) in a tab, because BiDi may
// not navigate to moz-extension:// URLs. The test then uses its controls.
// Firefox is started with MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 so BiDi may script
// that page.
//
// 1. Popup shows the default (40). Open a Short, watch 3 Shorts (ArrowDown),
//    then set the slider to 10 in the popup: the open YouTube tab must apply it
//    live. Keep pressing Down: no reload up to the 10th distinct Short, then a
//    fresh page load on the 11th, still on that Short, with its player.
// 2. Untick the setting: 12 more distinct Shorts, no reload.
// 3. Tick it again, open a /watch video and follow 10 related-video links
//    (in-page navigations). On the 11th, seek to 60 s at once: the reload must
//    keep the video and resume at that time (t=60s or a little more). If an ad
//    is playing the seek is not possible, and the timestamp check is skipped
//    with a NOTE.
// 4. "Start fresh session now": with the YouTube tab active, reload the
//    popup page (it is a background tab) and click its button: the YouTube
//    tab must reload at once on the same video, keeping the time with t=.
//    Before that, while the popup's own tab is active, the button must be
//    disabled with a note, and the popup must say "fresh session".
//    Before the click the test sets the player to 1.5x and 480p (the calls the
//    player's own menu makes): after the reload both must be set again, and
//    the saved entry gone from sessionStorage. Then the same on a Short at 2x
//    with quality left on Auto: 2x comes back and quality stays on Auto.
// 5. A click just as the reload starts: with the setting at 10, follow
//    related videos until the add-on logs that it is reloading, then at once
//    click (a real mouse click) another related video, while the old page is
//    still there. The fresh page must load the clicked video and its player,
//    with no t= from the video before. (0.1.4 loaded the video before.)
// --only button runs the popup checks and section 4 alone (about a minute).
// --only click runs the popup checks and section 5 alone (about a minute).
// The test copy of the add-on also mutes every tab and every video, on top of
// media.volume_scale=0.0, so no sound plays.
// Playback after a reload is checked only when a page the test loads itself
// starts playing: in a window without the OS focus YouTube does not start
// playback on fresh page loads at all, with or without the add-on.
// Exit code 0 = all checks passed, 1 = a check failed, 2 = harness error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const OUT = opt('out', null);
const ONLY = opt('only', null); // 'button': only the popup checks and section 4; 'click': section 5
const PORT = Number(process.env.FF_BIDI_PORT || 9558);
const CHANNEL = process.env.SHORTS_CHANNEL || 'https://www.youtube.com/@MrBeast/shorts';
const LOW = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN_FF = '/mnt/c/Program Files/Mozilla Firefox/firefox.exe';
const isWsl = !process.env.FIREFOX_BIN && fs.existsSync(WIN_FF);
const FIREFOX = process.env.FIREFOX_BIN || (isWsl ? WIN_FF : 'firefox');
const toFf = (p) => (isWsl ? execFileSync('wslpath', ['-w', p]).toString().trim() : p);
const tmpBase = isWsl
  ? execFileSync('wslpath', ['-u', execFileSync('cmd.exe', ['/c', 'echo %TEMP%'], { cwd: '/mnt/c' }).toString().trim()]).toString().trim()
  : os.tmpdir();

const src = path.join(root, 'dist', 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));

const runDir = fs.mkdtempSync(path.join(tmpBase, 'shorts-fix-refresh-test-'));
const profile = path.join(runDir, 'profile');
fs.mkdirSync(profile);
fs.writeFileSync(path.join(profile, 'user.js'), [
  ['media.volume_scale', '"0.0"'],
  ['browser.shell.checkDefaultBrowser', 'false'],
  ['browser.aboutwelcome.enabled', 'false'],
  ['browser.startup.homepage_override.mstone', '"ignore"'],
  ['datareporting.policy.dataSubmissionEnabled', 'false'],
  ['toolkit.telemetry.reportingpolicy.firstRun', 'false'],
  ['app.update.disabledForTesting', 'true'],
  ['browser.tabs.warnOnClose', 'false'],
].map(([k, v]) => `user_pref("${k}", ${v});`).join('\n') + '\n');

const log = [];
const say = (...a) => { const line = a.join(' '); log.push(line); console.log(line); };
let failures = 0;
let checks = 0;
const expect = (ok, label, detail = '') => {
  checks++;
  if (!ok) failures++;
  say(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' ' + detail : ''}`);
  return ok;
};

// Page state: the document's identity (timeOrigin changes on a real page load,
// as does the marker this test sets), the URL's video and the player's.
const STATE = () => {
  const u = new URL(location.href);
  const urlId = u.pathname === '/watch' ? u.searchParams.get('v') : (u.pathname.match(/^\/shorts\/([^/?#]+)/) || [])[1] || null;
  const shorts = u.pathname.startsWith('/shorts/');
  const mp = document.querySelector(shorts ? '#shorts-player' : '#movie_player');
  let playerId = null;
  try { playerId = mp.getVideoData().video_id || null; } catch (e) {}
  const v = shorts ? null : document.querySelector('#movie_player video');
  return {
    href: location.href, urlId, playerId, timeOrigin: performance.timeOrigin,
    marker: window.__refreshE2eMarker ?? null,
    t: u.searchParams.get('t'), time: v ? Math.round(v.currentTime) : null,
    ad: !!document.querySelector('#movie_player.ad-showing'),
    playing: (() => { try { return mp.getPlayerState() === 1; } catch (e) { return null; } })(),
    exactTime: v ? v.currentTime : null,
  };
};
const mark = (page, label) => page.evaluate((l) => { window.__refreshE2eMarker = l; }, label);
// The player's speed and chosen quality ('auto' when on Auto), and whether
// the add-on's saved entry is still in sessionStorage.
const PLAYBACK = () => {
  const mp = document.querySelector(location.pathname.startsWith('/shorts/') ? '#shorts-player' : '#movie_player');
  const r = {};
  try { r.rate = mp.getPlaybackRate(); r.preferred = mp.getPreferredQuality(); r.quality = mp.getPlaybackQuality(); } catch (e) { r.error = e.message; }
  r.videoRate = mp?.querySelector('video')?.playbackRate ?? null;
  r.entry = sessionStorage.getItem('ytShortsFixPlayback');
  r.ad = !!mp?.classList.contains('ad-showing');
  return r;
};

async function setPopup(popup, change) {
  await popup.evaluate((c) => {
    if ('enabled' in c) {
      const box = document.getElementById('enabled');
      if (box.checked !== c.enabled) box.click();
    }
    if ('threshold' in c) {
      const s = document.getElementById('threshold');
      s.value = String(c.threshold);
      s.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, change);
  await sleep(300);
  const shown = await popup.evaluate(() => ({
    enabled: document.getElementById('enabled').checked,
    slider: Number(document.getElementById('threshold').value),
    value: document.getElementById('value').textContent,
  }));
  const stored = await popup.evaluate(() => browser.storage.local.get(null));
  say('popup', JSON.stringify(shown), 'storage', JSON.stringify(stored));
  return { shown, stored };
}

// Wait for a navigation to settle and return the state, or the last state
// seen once the URL has stayed on a video for a while.
async function settle(page, ms = 3000) {
  await sleep(ms);
  for (let i = 0; i < 20; i++) {
    const s = await page.evaluate(STATE).catch(() => null);
    if (s && s.urlId) return s;
    await sleep(500);
  }
  return page.evaluate(STATE);
}

let browser;
let ff;
let exitCode = 2;
try {
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  say(`firefox=${FIREFOX} profile=${toFf(profile)} port=${PORT}`);
  ff = spawn(FIREFOX, ['-no-remote', '-new-instance', '-profile', toFf(profile), '--remote-debugging-port', String(PORT), 'about:blank'],
    {
      stdio: 'ignore', detached: false,
      // lets BiDi script the extension's popup page (this test's Firefox only);
      // WSLENV passes it on to the Windows Firefox under WSL
      env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1', WSLENV: [process.env.WSLENV, 'MOZ_REMOTE_ALLOW_SYSTEM_ACCESS'].filter(Boolean).join(':') },
    });
  for (let i = 0; i < 60 && !browser; i++) {
    await sleep(1000);
    browser = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${PORT}/session`, protocol: 'webDriverBiDi', defaultViewport: null }).catch(() => null);
  }
  if (!browser) throw new Error('could not connect to Firefox over BiDi');
  say('firefox', await browser.version());
  const ext = path.join(runDir, 'extension');
  fs.cpSync(src, ext, { recursive: true });
  fs.writeFileSync(path.join(ext, 'test-open-popup.js'), [
    "browser.tabs.create({ url: 'popup.html' });",
    '// test-only: mute every tab',
    'const muteTab = (t) => { if (t && !t.mutedInfo?.muted) browser.tabs.update(t.id, { muted: true }).catch(() => {}); };',
    'browser.tabs.query({}).then((ts) => ts.forEach(muteTab));',
    'browser.tabs.onCreated.addListener(muteTab);',
    'browser.tabs.onUpdated.addListener((id, change, t) => muteTab(t));',
  ].join('\n') + '\n');
  // test-only: keep every video and audio element muted
  fs.writeFileSync(path.join(ext, 'test-mute-media.js'),
    "setInterval(() => document.querySelectorAll('video,audio').forEach((v) => { if (!v.muted) v.muted = true; }), 200);\n");
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({
    ...manifest,
    background: { scripts: ['test-open-popup.js'] },
    content_scripts: [...manifest.content_scripts, { matches: manifest.content_scripts[0].matches, js: ['test-mute-media.js'], run_at: 'document_start', world: 'MAIN' }],
  }, null, 2));
  const yt = (await browser.pages())[0];
  say('installed temporary add-on', await browser.installExtension(toFf(ext)), manifest.version);
  // BiDi lists the popup tab as about:blank, so ask each tab where it is.
  let popup = null;
  for (let i = 0; i < 40 && !popup; i++) {
    await sleep(500);
    for (const p of await browser.pages()) {
      const href = await p.evaluate(() => location.href).catch(() => '');
      if (/^moz-extension:\/\/[^/]+\/popup\.html$/.test(href)) { popup = p; say('popup page', href); }
    }
  }
  if (!popup) throw new Error('the popup page did not open');
  await sleep(1000);
  const def = await popup.evaluate(() => ({
    enabled: document.getElementById('enabled').checked,
    value: document.getElementById('value').textContent,
    min: document.getElementById('threshold').min, max: document.getElementById('threshold').max,
  }));
  expect(def.enabled && def.value === '40' && def.min === '10' && def.max === '100', 'popup default', JSON.stringify(def));
  const btn0 = await popup.evaluate(() => ({
    hint: document.getElementById('hint').textContent,
    label: document.getElementById('refresh-now').textContent,
    disabled: document.getElementById('refresh-now').disabled,
    note: document.getElementById('refresh-note').hidden ? null : document.getElementById('refresh-note').textContent,
  }));
  expect(/the next video opens in a fresh session\./.test(btn0.hint), 'popup says "fresh session"', JSON.stringify(btn0.hint));
  expect(btn0.label === 'Start fresh session now' && btn0.disabled && !!btn0.note,
    'button disabled with a note while a non-YouTube tab is active', JSON.stringify(btn0));

  let s;
  if (!ONLY) {
    // ---- 1. Shorts, threshold changed live from 40 to 10 ----------------------
    await yt.bringToFront();
    await yt.goto(CHANNEL, { waitUntil: 'load', timeout: 90000 });
    await sleep(4000);
    const first = await yt.evaluate(() => [...document.querySelectorAll('a[href*="/shorts/"]')]
      .map((a) => a.getAttribute('href')).find((h) => /^\/shorts\/[^/?&]+/.test(h)));
    if (!first) throw new Error('no Short found on the channel grid');
    await yt.goto(`https://www.youtube.com${first}`, { waitUntil: 'load', timeout: 90000 });
    s = await settle(yt, 4000);
    await mark(yt, 'session1');
    // Baseline: whether a page the test loads itself starts playing. In an
    // automated window that does not have the OS focus, YouTube does not start
    // playback on a fresh page load at all, add-on or not.
    const baseShort = (await yt.evaluate(STATE)).playing;
    say('baseline: a directly loaded Short plays:', baseShort);
    const origin1 = s.timeOrigin;
    const seen = new Set([s.urlId]);
    say('start', JSON.stringify(s));
    const down = async () => {
      await yt.keyboard.press('ArrowDown');
      return settle(yt, 2500);
    };
    let presses = 0;
    while (seen.size < 3 && presses++ < 15) { s = await down(); seen.add(s.urlId); }
    expect(seen.size === 3 && s.timeOrigin === origin1, 'watched 3 Shorts, no reload', `seen=${seen.size}`);

    const r1 = await setPopup(popup, { threshold: LOW });
    expect(r1.shown.value === String(LOW) && r1.stored.refreshThreshold === LOW, `popup slider set to ${LOW} and saved`);
    await yt.bringToFront();
    await sleep(500);

    presses = 0;
    let reloaded = null;
    while (!reloaded && presses++ < 40) {
      const before = seen.size;
      await yt.keyboard.press('ArrowDown');
      await sleep(2500);
      s = await settle(yt, 1500);
      if (s.timeOrigin !== origin1) { reloaded = s; break; }
      seen.add(s.urlId);
      if (seen.size !== before) say(`  short ${seen.size} ${s.urlId} (same page)`);
      if (seen.size > LOW + 1) break;
    }
    expect(!!reloaded, `fresh page load after the ${LOW}th Short`, JSON.stringify(reloaded || s));
    if (reloaded) {
      expect(seen.size === LOW, `no reload up to Short ${LOW}`, `distinct before reload=${seen.size}`);
      expect(reloaded.marker === null, 'old page gone (test marker cleared)');
      expect(!seen.has(reloaded.urlId) && reloaded.urlId && reloaded.playerId === reloaded.urlId,
        'reloaded on the next (11th) Short, its player on it', `url=${reloaded.urlId} player=${reloaded.playerId}`);
      await sleep(2000);
      const p = await yt.evaluate(STATE);
      if (baseShort) expect(p.playing === true, 'Short plays after the reload', `playing=${p.playing}`);
      else say(`NOTE playback after the reload not checked: fresh loads do not autoplay in this window (playing=${p.playing})`);
    }
    if (OUT) await yt.screenshot({ path: path.join(OUT, 'shorts-after-reload.png') }).catch(() => {});

    // ---- 2. Off: no reload ----------------------------------------------------
    const r2 = await setPopup(popup, { enabled: false });
    expect(r2.shown.value === 'Off' && r2.stored.refreshEnabled === false, 'popup set to Off and saved');
    await yt.bringToFront();
    await sleep(500);
    s = await yt.evaluate(STATE);
    await mark(yt, 'session2');
    const origin2 = s.timeOrigin;
    const seen2 = new Set([s.urlId]);
    presses = 0;
    while (seen2.size < LOW + 2 && presses++ < 40) { s = await down(); seen2.add(s.urlId); if (s.timeOrigin !== origin2) break; }
    expect(seen2.size >= LOW + 2 && s.timeOrigin === origin2 && s.marker === 'session2', `Off: ${seen2.size} Shorts, no reload`);

    // ---- 3. /watch with timestamp ---------------------------------------------
    const r3 = await setPopup(popup, { enabled: true });
    expect(r3.shown.value === String(LOW) && r3.stored.refreshEnabled === true, `popup back on at ${LOW}`);
    await yt.bringToFront();
    await yt.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', { waitUntil: 'load', timeout: 90000 }); // "Me at the zoo"
    s = await settle(yt, 5000);
    await mark(yt, 'session3');
    await sleep(2000);
    const baseWatch = (await yt.evaluate(STATE)).playing;
    say('baseline: a directly loaded /watch video plays:', baseWatch);
    const origin3 = s.timeOrigin;
    const seen3 = new Set([s.urlId]);
    say('watch start', JSON.stringify(s));
    // Follow a related video the user has not opened yet, by clicking its link
    // (YouTube handles that as an in-page navigation).
    const follow = () => yt.evaluate((seenIds) => {
      const links = [...document.querySelectorAll('#secondary a[href^="/watch?v="], #related a[href^="/watch?v="]')];
      for (const a of links) {
        const id = new URL(a.href).searchParams.get('v');
        if (id && !seenIds.includes(id) && !new URL(a.href).searchParams.has('list')) { a.click(); return id; }
      }
      return null;
    }, [...seen3]);
    let watchReload = null;
    let seekedTo = null;
    let waitWhy = '';
    for (let k = 0; k < LOW + 3 && !watchReload; k++) {
      const id = await follow();
      if (!id) { say('  no related link to follow'); break; }
      if (seen3.size === LOW) {
        // The reload is due on this navigation, about 1 s after it lands. Seek
        // as soon as the watch page shows the new video, before the reload.
        for (let i = 0; i < 40; i++) {
          const r = await yt.evaluate((want) => {
            const flexy = document.querySelector('ytd-watch-flexy');
            const v = document.querySelector('#movie_player video');
            if (flexy?.getAttribute('video-id') !== want) return { wait: `flexy video-id ${flexy?.getAttribute('video-id')}` };
            if (!v) return { wait: 'no video' };
            if (document.querySelector('#movie_player.ad-showing')) return { wait: 'ad' };
            try { document.querySelector('#movie_player').seekTo(60, true); } catch (e) { v.currentTime = 60; }
            return { seeked: Math.round(v.currentTime) };
          }, id).catch((e) => ({ wait: 'error ' + e.message.slice(0, 80) }));
          if (r.seeked !== undefined) { seekedTo = r.seeked; break; }
          waitWhy = r.wait;
          await sleep(50);
        }
        say(`  video ${seen3.size + 1} ${id}: seek result ${seekedTo}${seekedTo === null ? ` (${waitWhy})` : ''}`);
      }
      s = await settle(yt, 4000);
      if (s.timeOrigin !== origin3) { watchReload = { ...s, expectedId: id }; break; }
      seen3.add(s.urlId);
      say(`  video ${seen3.size} ${s.urlId} (same page)`);
    }
    expect(!!watchReload, `/watch: fresh page load after the ${LOW}th video`, JSON.stringify(watchReload || s));
    if (watchReload) {
      expect(seen3.size === LOW, `/watch: no reload up to video ${LOW}`, `distinct before reload=${seen3.size}`);
      expect(watchReload.urlId === watchReload.expectedId && watchReload.marker === null, '/watch: reloaded on the current video',
        `url=${watchReload.urlId} clicked=${watchReload.expectedId}`);
      if (seekedTo !== null && seekedTo >= 59) {
        const tSec = parseInt(watchReload.t || '0', 10);
        await sleep(3000);
        const after = await yt.evaluate(STATE);
        expect(tSec >= 60 && tSec <= 70 && after.time >= 59, '/watch: timestamp kept', `t=${watchReload.t} playerTime=${after.time} ad=${after.ad}`);
        await sleep(2000);
        const later = await yt.evaluate(STATE);
        const detail = `playing=${later.playing} time ${after.exactTime?.toFixed(1)} -> ${later.exactTime?.toFixed(1)} ad=${later.ad}`;
        if (baseWatch) expect(later.playing === true && later.exactTime > after.exactTime, '/watch: plays on after the reload', detail);
        else say(`NOTE /watch playback after the reload not checked: fresh loads do not autoplay in this window (${detail})`);
      } else {
        say(`NOTE /watch timestamp not checked: could not seek before the reload (${seekedTo}; an ad may have been playing)`);
      }
    }
    if (OUT) await yt.screenshot({ path: path.join(OUT, 'watch-after-reload.png') }).catch(() => {});
  }

  if (!ONLY || ONLY === 'button') {
    // ---- 4. Start fresh session now ------------------------------------------
    // Big Buck Bunny: up to 2160p, so 480p is one of its qualities.
    await yt.bringToFront();
    await yt.goto('https://www.youtube.com/watch?v=aqz-KE-bpKQ', { waitUntil: 'load', timeout: 90000 });
    s = await settle(yt, 5000);
    await mark(yt, 'session4');
    const seekTo = await yt.evaluate(() => {
      if (document.querySelector('#movie_player.ad-showing')) return null;
      try { document.querySelector('#movie_player').seekTo(10, true); } catch (e) { document.querySelector('#movie_player video').currentTime = 10; }
      return 10;
    }).catch(() => null);
    await sleep(1000);
    // Speed and quality as the player's menu sets them.
    await yt.evaluate(() => { const mp = document.querySelector('#movie_player'); mp.setPlaybackRate(1.5); mp.setPlaybackQualityRange('large', 'large'); });
    await sleep(1000);
    const pb4 = await yt.evaluate(PLAYBACK);
    say('playback before the reload', JSON.stringify(pb4));
    const before4 = await yt.evaluate(STATE);
    // Reload the popup page, check its button, click it, and return the YouTube
    // tab's state once its fresh page has loaded (or null).
    // keepOpen: stop the popup page closing itself after the click, so the test
    // can click it again.
    const clickFreshSession = async (before, { keepOpen = false } = {}) => {
      await popup.evaluate(() => location.reload()).catch(() => {}); // BiDi's own reload waits for a load event a background tab may not report
      await sleep(1500);
      const btn = await popup.evaluate(() => ({
        disabled: document.getElementById('refresh-now').disabled,
        noteHidden: document.getElementById('refresh-note').hidden,
      }));
      expect(!btn.disabled && btn.noteHidden, 'button enabled while the YouTube tab is active', JSON.stringify(btn));
      if (keepOpen) await popup.evaluate(() => { window.close = () => {}; });
      const clickedAt = Date.now();
      await popup.evaluate(() => document.getElementById('refresh-now').click()).catch(() => {}); // the popup closes itself
      for (let i = 0; i < 20; i++) {
        await sleep(250);
        const st = await yt.evaluate(STATE).catch(() => null);
        if (st && st.timeOrigin !== before.timeOrigin) return { ...st, ms: Date.now() - clickedAt };
      }
      return null;
    };
    // The new page's playback, once the add-on has set it again (or after 30 s,
    // plus the length of any ad).
    const playbackAfter = async (done) => {
      let pb = null;
      for (let i = 0; i < 120; i++) {
        await sleep(500);
        pb = await yt.evaluate(PLAYBACK).catch(() => null);
        if (pb && pb.entry === null && done(pb)) break;
        if (pb?.ad) i = Math.min(i, 60);
      }
      await sleep(2000); // and it stays so
      return yt.evaluate(PLAYBACK).catch(() => pb);
    };
    const fresh = await clickFreshSession(before4, { keepOpen: true });
    expect(!!fresh && fresh.marker === null && fresh.urlId === before4.urlId,
      'button: fresh page load at once, on the same video', JSON.stringify(fresh));
    if (fresh && seekTo !== null && before4.time >= 10) {
      const tSec = parseInt(fresh.t || '0', 10);
      expect(tSec >= 10 && tSec <= before4.time + 3, 'button: time kept with t=', `t=${fresh.t} before=${before4.time}`);
    } else if (fresh) say(`NOTE button timestamp not checked (seek=${seekTo} time=${before4.time} ad=${before4.ad})`);
    if (fresh) {
      if (pb4.rate === 1.5 && pb4.preferred === 'large') {
        const pb = await playbackAfter((x) => x.rate === 1.5 && x.preferred === 'large');
        expect(pb.rate === 1.5 && pb.videoRate === 1.5 && pb.preferred === 'large' && pb.quality === 'large' && pb.entry === null,
          'button: speed 1.5x and quality 480p kept over the reload', JSON.stringify(pb));
      } else say(`NOTE /watch speed and quality not checked: could not set them before the reload (${JSON.stringify(pb4)})`);
    }
    if (OUT) await yt.screenshot({ path: path.join(OUT, 'after-fresh-session-button.png') }).catch(() => {});

    // ---- 4b. The same on a Short: 2x kept, quality left on Auto ---------------
    await yt.goto(CHANNEL, { waitUntil: 'load', timeout: 90000 });
    await sleep(4000);
    const short4 = await yt.evaluate(() => [...document.querySelectorAll('a[href*="/shorts/"]')]
      .map((a) => a.getAttribute('href')).find((h) => /^\/shorts\/[^/?&]+/.test(h)));
    if (!short4) throw new Error('no Short found on the channel grid');
    await yt.goto(`https://www.youtube.com${short4}`, { waitUntil: 'load', timeout: 90000 });
    await settle(yt, 4000);
    await yt.evaluate(() => {
      const mp = document.querySelector('#shorts-player');
      mp.setPlaybackRate(2);
      mp.setPlaybackQualityRange('auto', 'auto');
    });
    await sleep(1000);
    const pbS = await yt.evaluate(PLAYBACK);
    say('Short playback before the reload', JSON.stringify(pbS));
    const freshS = await clickFreshSession(await yt.evaluate(STATE), { keepOpen: !ONLY }); // section 5 still needs the popup
    expect(!!freshS && freshS.marker === null && `/shorts/${freshS.urlId}` === short4.split(/[?#]/)[0],
      'button on a Short: fresh page load on the same Short', JSON.stringify(freshS));
    if (freshS && pbS.rate === 2 && pbS.preferred === 'auto') {
      const pb = await playbackAfter((x) => x.rate === 2);
      expect(pb.rate === 2 && pb.videoRate === 2 && pb.preferred === 'auto' && pb.entry === null,
        'button on a Short: speed 2x kept, quality left on Auto', JSON.stringify(pb));
    } else if (freshS) say(`NOTE Short speed not checked: could not set it before the reload (${JSON.stringify(pbS)})`);

  }

  // ---- 5. A click just as the reload starts --------------------------------
  if (!ONLY || ONLY === 'click') {
    const r5 = await setPopup(popup, { enabled: true, threshold: LOW });
    expect(r5.stored.refreshThreshold === LOW && r5.stored.refreshEnabled === true, `popup at ${LOW} for the click check`);
    await yt.bringToFront();
    let reloadLogged = 0;
    const onConsole = (m) => { if (m.text().includes('reloading YouTube in a fresh page to free memory')) reloadLogged = Date.now(); };
    yt.on('console', onConsole);
    await yt.goto('https://www.youtube.com/watch?v=aqz-KE-bpKQ', { waitUntil: 'load', timeout: 90000 });
    s = await settle(yt, 5000);
    await mark(yt, 'session5');
    const origin5 = s.timeOrigin;
    const seen5 = new Set([s.urlId]);
    // Marks a related video the user has not opened yet, in view, and
    // returns its id.
    const pickRelated = () => yt.evaluate((seenIds) => {
      document.querySelectorAll('[data-e2e-pick]').forEach((a) => a.removeAttribute('data-e2e-pick'));
      for (const a of document.querySelectorAll('#secondary a[href^="/watch?v="]')) {
        const u = new URL(a.href);
        const id = u.searchParams.get('v');
        if (id && !seenIds.includes(id) && !u.searchParams.has('list') && a.offsetParent && a.getBoundingClientRect().height > 20) {
          a.setAttribute('data-e2e-pick', '1');
          return id;
        }
      }
      return null;
    }, [...seen5]).catch(() => null);
    // A real mouse click on that video (retried while the sidebar re-renders).
    const clickRelated = async () => {
      for (let i = 0; i < 10; i++) {
        const id = await pickRelated();
        const h = id && await yt.$('a[data-e2e-pick="1"]').catch(() => null);
        if (h && await h.click().then(() => true, () => false)) return id;
        await sleep(50);
      }
      return null;
    };
    let clicked = null;
    let clickMs = null;
    let fresh5 = null;
    for (let k = 0; k < LOW + 4 && !clicked; k++) {
      const id = await clickRelated();
      if (!id) { say('  no related link to click'); break; }
      seen5.add(id);
      // Wait for the add-on to start its reload (or for this video to settle).
      for (let i = 0; i < 400 && !reloadLogged; i++) await sleep(10);
      if (reloadLogged) {
        clicked = await clickRelated(); // at once, while the old page is still there
        clickMs = Date.now() - reloadLogged;
        say(`  reload started on video ${seen5.size} (${id}); clicked ${clicked} ${clickMs} ms later`);
        break;
      }
      await sleep(500);
    }
    if (clicked) {
      for (let i = 0; i < 60 && !fresh5; i++) {
        await sleep(250);
        const st = await yt.evaluate(STATE).catch(() => null);
        if (st && st.timeOrigin !== origin5 && st.urlId === st.playerId && st.playerId) fresh5 = st;
      }
      await sleep(2000);
      if (fresh5) fresh5 = await yt.evaluate(STATE);
      const tSec = parseInt(fresh5?.t || '0', 10);
      expect(!!fresh5 && fresh5.marker === null && fresh5.urlId === clicked && fresh5.playerId === clicked && tSec <= 5,
        'click as the reload starts: the fresh page plays the clicked video, with no t= from the one before',
        `clicked=${clicked} (${clickMs} ms after the reload started) ${JSON.stringify(fresh5)}`);
    } else expect(false, 'click as the reload starts: the reload started, and a related video was clicked', `seen=${seen5.size}`);
    yt.off('console', onConsole);
    if (OUT) await yt.screenshot({ path: path.join(OUT, 'after-click-during-reload.png') }).catch(() => {});
  }

  say(`RESULT refresh e2e: ${checks - failures}/${checks} checks passed`);
  exitCode = failures ? 1 : 0;
} catch (e) {
  say('HARNESS ERROR', e?.stack || String(e));
  exitCode = 2;
} finally {
  if (OUT) fs.writeFileSync(path.join(OUT, 'refresh-e2e.log'), log.join('\n') + '\n');
  if (browser) await browser.close().catch(() => {});
  await sleep(2000);
  if (ff && ff.exitCode === null) ff.kill();
  await sleep(1000);
  fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
}
process.exit(exitCode);
