# YouTube Shorts & Lag Fix

A small browser add-on that does two things on YouTube:
- **Shorts fix:** stops YouTube Shorts showing or playing the wrong video. Normal Shorts scrolling is unchanged. This part is also built as a userscript.
- **Lag fix:** stops long YouTube sessions getting slow by reloading the page every 40 videos (adjustable), between two videos. See [Lag fix](#lag-fix-reload-every-n-videos).

This project is not affiliated with YouTube or Google.

## The problem

1. Open a Short from a channel's Shorts tab (A).
2. Press Back.
3. Open a different Short from the same tab (B).

The address bar, the player and the audio are all on B. The screen stays on a still frame of A, with no title or buttons. B is playing off-screen, one slot below. Pressing Down then skips B.

- **Firefox:** breaks as soon as B opens.
- **Chrome and Edge:** B opens correctly, then the first Down key snaps the screen back to A's still frame while B keeps playing.

A second, intermittent form: keep opening Shorts from the channel's Shorts tab and going Back. Now and then the Short that opens is not the one you clicked. It is one of the channel's Shorts listed before it, and the address bar changes to that Short too.
## Why it happens

The bug is in YouTube's Shorts page, not in the browser. Firefox just hits it sooner.

**How the page is built.** The Shorts page is a scrollable list of slots, one per Short. There is only one real video player. YouTube moves it into the slot of the Short you are watching; every other slot only shows a thumbnail.

**Earlier Shorts get inserted above.** When you re-enter Shorts from a channel's grid, YouTube inserts the earlier Short(s) above the current one, as "previous" slots.

**The faulty correction.** YouTube has a one-time scroll correction, meant to re-align the list after a fullscreen or size change. It is switched on by a flag, `shouldUpdateItemHeight`, on the `<ytd-shorts>` element. When it runs, it sets:

```js
scrollTop = index * itemHeight + 16
```

That formula leaves out the previous slots. YouTube's code for reading the scroll position does subtract them; this code for writing it does not.

**The result.** With one previous Short above, the correction scrolls one slot too high, onto A's thumbnail. The player stays in B's slot. YouTube thinks it is already showing B, so nothing ever corrects it.

**When it fires.** The flag starts out on, and every fullscreen change turns it on again. It fires at the first scroll that happens while previous slots exist.

**Why Firefox and Chromium differ.** They handle the scroll position differently when slots are inserted above the visible one.
- In Firefox, YouTube's own scroll to B triggers the correction immediately.
- In Chromium, no scroll happens on open. The correction stays on until your next scroll, such as the Down key.

### The intermittent wrong video

**The scroll position picks the Short.** On every scroll of the list, YouTube works out which slot is in view and loads that Short if it is not the current one:

```js
index = Math.round((scrollTop - 16) / itemHeight) - previousSlots
```

Moving to the next Short (Down key, swipe, auto-advance) works this way: YouTube scrolls, then this code loads the Short that is now in view.

**The race on opening a Short.** When you click a Short in a channel's grid, YouTube adds the previous slots above it. Sometimes they appear while the list is still at the very top, before YouTube has scrolled down to the Short you clicked. If a scroll event fires in that moment, the formula gives the first previous slot. YouTube then navigates there and plays that Short instead.

**Why it is intermittent.** It depends on timing: whether the previous slots render before or after YouTube's own scroll to your Short. Slow loads make it more likely, and the earlier fix did not change it.

## How the fix works

All the logic is in `src/shorts-fix.js`, which runs inside the YouTube page.

1. **Primary fix: prevents the stale thumbnail.** It keeps `<ytd-shorts>.shouldUpdateItemHeight` false, so the faulty correction never runs.
   - The correction only runs in an animation frame queued by YouTube's scroll listener on `#shorts-container`. The script clears the flag in a capture-phase `scroll` listener, which runs before YouTube's.
   - It also clears the flag after `fullscreenchange`, where YouTube turns it back on, and on `yt-navigate-finish`.
   - YouTube's separate resize handler still re-aligns the view after a size change, and does it correctly.
2. **Fallback watchdog: repairs the view if a YouTube update gets past the primary fix.**
   - Every 250 ms on `/shorts/` pages, it compares two slots: the slot centred in `#shorts-container`, and the slot holding the player (`#reel-overlay-container`).
   - It acts only when all of these hold:
     - The two slots have differed for 600 ms.
     - There has been no wheel, key, touch or pointer input for 800 ms.
     - There has been no scroll for 400 ms.
     - The page is not in fullscreen.
     - The player's slot holds the Short named in the URL (checked by its thumbnail's video id).
   - It then scrolls the player's slot back into view. It never touches the player.
   - **Why the URL check matters:** during a normal move, YouTube can scroll to the new Short a moment before it moves the player out of the old slot. Scrolling back to the old slot at that moment would make YouTube navigate back to the old Short.
3. **Entry guard: prevents the intermittent wrong video.**
   - It is on from the moment you open a Short from a page that is not Shorts, such as a channel's grid (`yt-navigate-start`).
   - It goes off at your first wheel, key, touch or pointer input, once the clicked Short has been centred for 1.5 s, or after 10 s.
   - While it is on, every scroll of `#shorts-container` is checked with YouTube's own formula (above), just before YouTube reads the position:
     - Its capture-phase `scroll` listener runs before YouTube's, so the animation frame it queues runs just before the one YouTube queues.
     - In that frame, if the formula would give a Short other than the current one, it sets `scrollTop` to the value the formula maps to the current Short: `(index + previousSlots) * itemHeight + 16`.
     - "The current one" is YouTube's own `<ytd-shorts>.index`, and only when that slot's thumbnail is the Short in the URL.
   - It uses the formula, not the slot positions on screen, because the two disagree for a moment while the player is still in YouTube's first container. An earlier version that scrolled the centred slot into view sometimes made YouTube load the next Short.
   - It stands aside while `shouldUpdateItemHeight` is on. YouTube's frame then re-aligns instead of loading a Short, which is the primary fix's and the watchdog's job.
   - It does nothing if `index`, `itemHeight`, the list of previous slots, the slot or the thumbnail is missing, or does not match the URL.
   - **Why it switches off:** moving to another Short also works by scrolling (including auto-advance, which has no input). The guard is only on while a Short is being opened, so it never fights a real move.
4. **Guardrails.**
   - Every YouTube property and selector is feature-detected. If anything is missing, the script does nothing, so a YouTube redesign cannot break playback.
   - It changes only that one flag and the Shorts list's scroll position.
   - It sets three properties on the page's `window`:
     - `__ytShortsFixLoaded` makes it run only once if both the add-on and the userscript are installed.
     - `__ytShortsFixCorrections` counts watchdog corrections. Read it in the browser console to see whether the watchdog has acted.
     - `__ytShortsFixEntryCorrections` counts entry-guard corrections.

## Lag fix: reload every N videos

A long YouTube session gets slower and slower. YouTube is a single-page app, and the tab's memory grows by roughly 80 MB for every video you open. That rate was measured in Firefox over 24 hours, and in one long session the tab reached 8.4 GB. Only a real page load gives that memory back.

So the add-on counts the distinct videos the tab opens, both `/watch?v=` videos and `/shorts/` Shorts. Each video counts once, however often you return to it. After 40 videos it loads the next video you open in a fresh page:
- **It lands between videos.** It waits for the navigation to the next new video after the count is reached, waits 1 s for that video to load, then loads the same URL again with `location.replace`. Back and Forward history stay as they were.
- **It keeps your place.** On `/watch` pages it adds `&t=<seconds>s` when the video is at least 1 s in, and keeps the other URL parameters, such as a playlist. It ignores the time while an ad is playing.
- **It keeps your speed and quality.** A fresh page would start at normal speed, and not always at the quality you picked. So just before the reload it saves the player's playback speed and the quality you chose in the player's menu. Once the new page's player has the same video loaded, with no ad showing, it sets both again, once. This works on `/watch` pages and on Shorts. A quality left on Auto stays on Auto. The saved values live in that tab's `sessionStorage` and are deleted as soon as the new page reads them, so a reload you do yourself is not affected. The add-on changes these settings at no other time.
- **It waits when the time is not right.** That means while you are typing in a box (search, comments) or the tab is hidden, and while the page is in fullscreen, up to 1.5 × the setting. Each time, it tries again at the next new video.
- After the reload the count starts again.

**Setting.** Click the add-on's toolbar button, or open its options in `about:addons`. A slider sets the number of videos, from 10 to 100 in steps of 5, with the current number shown next to it. Below it the popup says "After N videos, the next video opens in a fresh session." A checkbox turns the reload off. Changes apply at once to open YouTube tabs.

**Start fresh session now.** A button in the popup reloads the YouTube tab you are on at once, without waiting for the count. It reloads the same way as the automatic reload, keeping your place with `t=` on `/watch` pages and your speed and quality, and the count starts again. It works with the automatic reload turned off too. When the active tab is not a YouTube tab, as in `about:addons`, the button is greyed out with a short note.

The logic is in `src/refresh-core.js`. The content script is `src/refresh.js`, which runs in the add-on's isolated world, separate from the Shorts fix. The settings page is `src/popup.html` and `src/popup.js`. Keeping speed and quality is `src/playback-core.js` (the logic) and `src/playback.js`, which runs in the page's own world because only that world can use YouTube's player; `src/refresh.js` tells it to save the settings, with a `yt-shorts-fix-save-playback` event on the page, just before it reloads. The userscript does not include the lag fix.

### Privacy and permissions

- No network requests, analytics or data collection.
- The only messages are inside the add-on: when the popup opens it asks the active tab whether the add-on's YouTube script runs there, and the "Start fresh session now" button tells that script to reload.
- The add-on's only permission is `storage`, used to keep the lag fix setting on your computer (`storage.local`). Across its own reload it also keeps the playback speed and quality in the YouTube tab's `sessionStorage` for a moment (see above). Its only site access is `https://www.youtube.com/*` and `https://m.youtube.com/*`, where its scripts run.
- The manifest declares `data_collection_permissions: none` for Firefox.

## Build

You need Node 18 or newer.

```sh
npm install
npm run build
npm test        # unit tests for the lag fix logic, its popup, and keeping speed and quality
```

This writes:
- `dist/extension/`: the add-on, unpacked.
- `dist/shorts-fix.user.js`: the userscript.
- Two test-only builds, used by the tests below.

## Install

Pick one option. Don't install both the userscript and the add-on: the second copy just does nothing.

### Option 1: userscript (any browser, no signing)

1. Install a userscript manager: Violentmonkey (recommended) or Tampermonkey.
2. Open the manager's dashboard and create a new script.
3. Replace its contents with the whole of `dist/shorts-fix.user.js` and save.
4. Reload any open YouTube tab.

The userscript works in both of the manager's injection modes. If YouTube's Content-Security-Policy stops the manager injecting into the page itself, the script reaches the page's objects from the manager's isolated context instead.

### Option 2: Firefox, temporary load (for trying it out)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and choose `dist/extension/manifest.json`.

It stays until Firefox restarts. Firefox Developer Edition, Nightly and ESR can also keep unsigned add-ons permanently if you set `xpinstall.signatures.required` to `false`. Release Firefox ignores that setting.

### Option 3: Firefox, permanent install through self-signing

Release Firefox only keeps signed add-ons. You can have Mozilla sign your own copy as **unlisted**. It is then installable permanently, but not listed or searchable on addons.mozilla.org (AMO). This needs your own AMO account, and signing is automated, usually taking a few minutes.

1. Sign in at https://addons.mozilla.org.
2. Create API credentials at https://addons.mozilla.org/developers/addon/api/key/
3. Change the add-on ID: set `browser_specific_settings.gecko.id` in `extension/manifest.json` to your own value, for example `shorts-fix@your-domain.example`. An ID belongs to whoever signs it first.
4. Build and sign:
   ```sh
   npm install && npm run build
   npx --yes web-ext@8 sign --source-dir dist/extension --channel unlisted \
     --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET" --artifacts-dir dist
   ```
5. In Firefox, open `about:addons`, click the gear icon, choose **Install Add-on From File…**, and pick the signed `.xpi` in `dist/`.

To update, bump `version` in both `extension/manifest.json` and `package.json`, then sign again. The build stops if those two versions differ.

### Chrome / Edge: load unpacked (developer mode)

The same `dist/extension` is a Manifest V3 extension that Chromium browsers accept as it is. Its script runs in the page context (`"world": "MAIN"`), which needs Chrome/Edge 111 or newer.

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `dist/extension` folder.

The browser may warn about the Firefox-only key `browser_specific_settings`. It is ignored and harmless.

Checked in Microsoft Edge 157 (Chromium), one run each:
- **With the extension:** the script loaded and kept the flag off. Open A, Back, open B and three Down presses all stayed correct.
- **Without it:** the bug showed on the first Down press.

Google Chrome itself has not been tested. It uses the same engine and the same manifest rules.

## Check that it works

### By hand

1. Open a channel's Shorts tab, for example https://www.youtube.com/@MrBeast/shorts
2. Click the first Short, press Back, then click the second Short.
   - **Firefox without the fix:** on most page loads, you see the first Short's still image while the second one plays.
   - **Chrome/Edge without the fix:** press Down once to see it.
   - Toggling fullscreen on the first Short before pressing Back makes the bug show every time.
3. With the fix, the second Short is on screen with its title and buttons. Each Down or Up press moves exactly one Short.

### Lag fix test (Firefox)

`npm run test:refresh` runs `test/refresh-e2e.mjs`. It uses the same kind of throwaway, muted Firefox profile as the test below, on port 9558. It takes a little over 3 minutes.
- It checks that the settings page shows 40, then opens a Short, watches 3 and sets the slider to 10 while the YouTube tab is open.
- Then the page must not reload up to the 10th Short, and must reload on the 11th, on that Short.
- With the setting off, 12 more Shorts must not cause a reload.
- With it back on, it follows 10 related `/watch` videos and seeks the 11th to 60 s at once. The page must reload on that video with `t=60s`, and the player must be at 60 s.
- It then checks the "Start fresh session now" button. While the settings page's own tab is active, the button must be greyed out with a note. With the YouTube tab active, a click must reload that tab at once, on the same video with `t=`.
- Before that click it sets the player to 1.5× and 480p. After the reload both must be set again. It then does the same on a Short at 2× with quality on Auto: 2× must come back and quality must stay on Auto.
- `npm run test:refresh:button` runs only the button checks (`--only button`), in about a minute.
- Firefox starts with `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` so the test can use the settings page, which a test-only background script opens in a tab.

### Automated test (Firefox)

The test drives a real, visible Firefox window over WebDriver BiDi on port 9557 (`FF_BIDI_PORT` overrides this).
- It uses a brand-new temporary profile, deleted afterwards, and never touches your own profile.
- Audio is muted with `media.volume_scale=0.0`.
- On Linux it runs `firefox`. Under WSL it uses the Windows Firefox. Set `FIREFOX_BIN` to choose another.

It does the steps above, then 13 × Down and 13 × Up. After each step it checks three things:
- The centred slot is the player's slot.
- The player is playing the URL's video.
- The view moved exactly one slot.

```sh
npm run test:repro                    # with the add-on: all checks pass
node test/repro.mjs --mode none       # no add-on: fails (exit 1), which is the bug
node test/repro.mjs --mode fallback   # watchdog only, primary fix off: passes
node test/repro.mjs --mode userscript # the userscript, run from an isolated context: passes
node test/repro.mjs --scenario entry  # open/Back/open from the grid, race forced: passes (about 2 min)
node test/repro.mjs --scenario entry --mode none  # same without the add-on: fails
npm run test:proof -- --repeat 2      # all of the above, checked against the expected results
```

The `entry` scenario checks the intermittent wrong video quickly and deterministically.
- It opens 6 Shorts from the channel's grid with real mouse clicks, going Back in between, each with earlier Shorts before it.
- On each open, the moment the earlier Shorts' slots appear, it puts the list back at the top and fires a scroll event, 3 frames in a row. That is the state in which YouTube loads the first earlier Short.
- After each open it checks that the URL, the player and the centred slot all show the Short that was clicked.

The long, randomized `channel` scenario is optional and not part of the proof. It takes 20 to 40 minutes:

```sh
node test/repro.mjs --scenario channel                    # open, watch, Back, open another, 30 times
SHORTS_STRESS=1 node test/repro.mjs --scenario channel --mode none  # the intermittent bug, made frequent
```

It repeats the reported steps: open a Short from the channel's Shorts tab, watch for a few seconds, press Back, open another.
- It picks Shorts at random from the first 36 in the grid (seeded, `SHORTS_SEED`), sometimes going Back again at once, and waits a random time on the grid.
- After each open it checks that the URL, the player and the centred slot all show the Short that was clicked.
- On its own it fails rarely, between about 1 open in 10 and 1 in 100, so `SHORTS_STRESS=1` fires a scroll event on every frame while each Short opens. Each such event is a moment when YouTube reads the position, so the race shows up far more often.
- `--ext DIR` loads another unpacked add-on, for comparing versions.

On the first Short, before pressing Back, the test calls YouTube's own `ytd-shorts.onFullscreenChange()`.
- **What it does:** a real fullscreen toggle runs the same handler, and automation cannot enter fullscreen without a user gesture. It switches the faulty correction back on.
- **Why:** this makes the bug appear every time without the fix.
- **To skip it:** set `SHORTS_FULLSCREEN=0`.
- Other options are listed at the top of `test/repro.mjs`.

**Results** (Firefox 160 on Windows, logged out), fullscreen scenario:

| Mode | 0.1.0, final 3 rounds | 0.1.1, last round |
|---|---|---|
| No add-on | failed every time, which is the bug | failed, which is the bug |
| Add-on | passed every time | view and player always matched; 3 Up presses ignored (see Known limits) |
| Watchdog only | passed every time | passed |
| Userscript | passed every time | view and player always matched; 1 Up press ignored |

**Channel scenario results** (same setup):

| Build | `entry` | `channel` | `channel` with `SHORTS_STRESS=1` |
|---|---|---|---|
| No add-on | 5 wrong in 6 opens | 3 wrong in 30 opens | 2 wrong in 15 opens |
| 0.1.0 | 5 wrong in 6 opens | 4 wrong in 60 opens; 0 in 300 more | 19 wrong in 195 opens |
| 0.1.1 | 0 wrong in 6 opens | 0 wrong in 240 opens | 0 wrong in 195 opens |

## Known limits

- **Tested setup:** tested only logged out, on one channel's Shorts tab. Signed-in use, mobile (`m.youtube.com`) and Google Chrome are untested.
- **Fullscreen:** a real fullscreen toggle was not tested. The fix turns off YouTube's one-time re-align after fullscreen.
  - YouTube's resize handler and the watchdog still keep the right Short on screen.
  - The view might sit a few pixels off after leaving fullscreen.
- **Userscript managers:** installing through a userscript manager's own UI was not automated. Use the manual check above.
- **Occasional ignored Up key in testing:** some test runs have one or more Up presses, right after the 13th Down, that do not move the view. The view and the player stay matched, so it is not the wrong-video bug.
  - It happens with 0.1.0 as well as 0.1.1, mostly while several Firefox windows run at once, and the entry guard is idle then.
  - The watchdog's correction count rises with each ignored press, and the player is usually buffering. The likely cause is that YouTube's move stalls before it moves the player, and the watchdog then scrolls back to the player's slot. Not yet fixed.
- **Forced race in tests:** the bug depends on timing, so the `entry` scenario and `SHORTS_STRESS=1` force it with synthetic scroll events, which real use does not fire. A passing plain `channel` run proves little on its own.
- **Entry guard window:** the guard is on for at most 10 s after opening a Short, and off from your first input. A wrong load from a scroll event outside that window is not prevented.
- **Lag fix playback after the reload:** in the automated test, Firefox's window does not have the OS focus. There YouTube does not start playback on any fresh page load, with or without the add-on, so the test could not check that the video plays on after the reload. In a normal window YouTube may start it, or it may wait at the right video and time for you to press play.
- **Lag fix memory:** the 40-video default comes from the 24-hour measurement above. The add-on does not measure memory itself.
- **YouTube updates:** YouTube changes its front end often. If it renames the flag, the selectors or the slot layout, the script stops acting rather than breaking anything. The automated test will show that as the bug coming back.

## Repository layout

```
src/shorts-fix.js          all of the Shorts fix logic
src/refresh-core.js        lag fix logic (counting, when to reload, the reload URL, settings)
src/refresh.js             lag fix content script
src/popup.html, popup.js   lag fix settings and "Start fresh session now" (toolbar popup and options page)
extension/manifest.json    Manifest V3 (Firefox 140+, Chromium 111+)
scripts/build.mjs          builds dist/extension, dist/shorts-fix.user.js and two test-only builds
test/refresh-core.test.mjs lag fix unit tests (npm test)
test/popup.test.mjs        popup wording and "Start fresh session now" tests (npm test)
test/refresh-e2e.mjs       lag fix test in a real Firefox (npm run test:refresh)
test/repro.mjs             visible-browser Firefox reproduction test
test/proof.mjs             runs every test mode and checks each gives the expected result
```

## Releasing

1. Bump the version in `extension/manifest.json` and `package.json`.
2. Check the add-on: `npm run build && npx --yes web-ext@8 lint --source-dir dist/extension`
3. Package it: `npm run package` writes a `.zip` to `dist/` using `web-ext build`.
4. **Firefox:** submit the zip on AMO as a listed add-on, or run `web-ext sign --channel listed`.
   - The ID in `browser_specific_settings.gecko.id` is permanent once signed.
   - AMO may ask for source code. This repository is enough, because the build only copies files and does not minify.
5. **Chrome Web Store / Edge Add-ons (optional):** upload the same zip.
6. **Userscript:** publish `dist/shorts-fix.user.js`, for example on Greasy Fork or as a GitHub release asset.

## License

MIT. See [LICENSE](LICENSE).
