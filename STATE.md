# Project state — Photorealistic

_Last updated: 2026-11-10 (picker with cards live)_

Live site: https://photorealistic.yairsarig.workers.dev
Hosting: Cloudflare Workers (account yairsarig@gmail.com), deployed automatically on every push to `main` via Workers Builds.

## Routines

### Aura (current focus) — `/a`
A stand-alone fake camera opened from its own QR on the spectator's phone. Nothing is needed on the performer's phone.

Flow:
1. **Picker** — five rows of the real shadow images (only the performer sees the screen): ESP shapes; suits; A–5; 6–10; J Q K. A shape goes straight to the camera. A suit highlights and wakes the value rows; a value then goes to the camera with that card. A card is **one shadow, value above suit** (like a card's corner).
2. **Camera** — a preview of the symbol sits on the live viewfinder. Two fingers anywhere move, resize and rotate it (one finger does nothing). Chips: Glow/Shadow (vector set only) and strength %.
3. **Shutter** — builds the photo with the symbol blended in, camera-style file name (Samsung `YYYYMMDD_HHMMSS.jpg`, Pixel `PXL_…`, else `IMG_…`) and EXIF (make, model, time, timezone).
   - iPhone: the share sheet opens in the same tap → **Save Image** → Photos.
   - Android: downloads at once → Gallery, "Download" album.
4. Page jumps to Google. The phone is marked as used for 30 days: reopening the page (history, Safari suggestion, link) goes straight to Google. `/a?reset=1` clears it (testing).

Other: page title "Google". `?s=<shape>` skips the picker; `?set=shadow` picks the set; `?debug=1` shows the saved photo.

Addresses: `/aura` (setup page + Aura QR), `/a`, `/a?reset=1` (testing QR).

### Pluck — `/s/<code>` + `/r/<code>`
Photo taken via QR page on the spectator's phone, "plucked" out of the screen, revealed on the performer's phone (receiver). Exit after pluck is limited by the browser (tries closing the tab, then Android camera intents). Setup page `/`.

## Symbol sets (`public/sets/`)
- **Light** (drawn): circle, cross, waves, square, star — glow or shadow style.
- **Shadows** (`sets/shadow/`): the five ESP symbols, real photographed shadows, all from one matching image. Live.
- **Cards** (`sets/cards/`): hearts, diamonds, clubs, spades; A, 2–10, J, Q, K. Live: combined at pick time into one shadow (value over suit).

Image symbols are white-background layers multiplied onto the photo (white = no change), all normalised to the same depth (darkest ≈ 0.55).

To add new shadow images: `python3 tools/extract_shadows.py [--grow 0.012] [--depth 0.55] photo.png out_dir name1 name2 …` (names in reading order). Generate source images with the "real shadow on a plaster wall, lamp from the upper left" prompt so all sets match.

## Next
- Open question: keep cards as one shadow, or place value and suit as two separate shadows.
- The drawn "Light" set (glow) is no longer in the picker; still reachable with `?set=light`.
- Clouds set (images to be generated: cloud on pure black, blended with screen).
- Neutral custom domain, so Safari suggestions/history don't show the project name.
- iPhone not yet tested for every change; Android save location to verify on Samsung.

## Code map
- `src/index.ts` — Worker: routes, Relay Durable Object (Pluck relay + per-code settings).
- `public/aura.html|css|js` — Aura camera. `public/aura-setup.html` — Aura QR page.
- `public/spectator.*`, `public/receiver.*`, `public/index.*` — Pluck.
- `tools/` — shadow extraction scripts. `test/relay.test.mjs` — relay tests.
