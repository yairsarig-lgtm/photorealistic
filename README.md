# Photorealistic — Pluck

A magic trick. You borrow a spectator's phone, "take a photo" with their camera, pluck the photo out of their screen with your fingers, and push it into your own phone. Their gallery is genuinely empty afterward.

**v1 is Android / Chrome only.**

## How the trick works

| | What they see | What really happens |
|---|---|---|
| 1. The photo | You open their camera and take a photo of them. | As you raise the phone, your hidden QR passes the lens. You tap the link chip instead of the shutter, and their camera is now this web page. The photo is sent to your phone the moment you shoot. Nothing is saved on theirs. |
| 2. Isolate | You tap once; the edges fall away and the photo fills the screen. | First animation on the spectator page. |
| 3. Pluck | You pinch the middle; the photo condenses into your fingertips and is gone. The phone returns to the camera. | Hold = the photo gathers toward your finger. Lift = it collapses and vanishes. The page then opens the camera app and leaves only a Google tab behind. |
| 4. Check | Their gallery has no new photo. | True. |
| 5. Arrival | You touch your black phone; their photo grows out of your fingertip. | Your phone has had it since step 1, decoded and waiting. |

## Pages

- `/` — performer setup: create a code, show and download your QR, open your receiver.
- `/s/<CODE>` — spectator page (what the QR points to). Looks like nothing; title is "Camera".
  - `?exit=camera` (default) — after the pluck, open the phone's camera app.
  - `?exit=google` — after the pluck, go to Google.
  - `?exit=black` — stay black; you swipe home.
  - `&debug=1` — tiny status overlay (upload result, camera size).
- `/r/<CODE>` — receiver (your phone). Tap **Arm** to go black.
  - One buzz = photo arrived. Double buzz = it was plucked on their phone.
  - Touch the screen to reveal.
  - Hold the top-left corner 1.5 s: reset (or, if already empty, back to setup).

## Privacy

Photos are never written to storage. The relay forwards the JPEG straight to the connected receiver and drops it. If your receiver isn't connected yet, the photo is held in memory for up to 10 minutes, then dropped.

## Architecture

One Cloudflare Worker (`src/index.ts`) serves the pages from `public/` and routes each performer code to its own Durable Object (`Relay`), which holds the receiver's WebSocket. The spectator page POSTs the photo; the relay pushes it to the receiver.

## Deploy

Automatic on every push to `main`, once two repository secrets are set:

1. Create a free Cloudflare account. In the dashboard, open **Workers & Pages** once so it assigns you a `*.workers.dev` subdomain.
2. **My Profile → API Tokens → Create Token →** template **"Edit Cloudflare Workers"** → create, copy the token.
3. Copy your **Account ID** (Workers & Pages overview, right side).
4. In GitHub: **Settings → Secrets and variables → Actions → New repository secret**:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
5. **Actions → Deploy → Run workflow** (or push any commit). The log prints the live URL, e.g. `https://photorealistic.<you>.workers.dev`.

Manual alternative from a computer: `npm install`, then `npx wrangler login` and `npx wrangler deploy`.

## Develop

```
npm install
npm run dev          # http://localhost:8787
npm test             # relay tests against the dev server (BASE=... to point elsewhere)
```

The camera needs HTTPS on a real phone, so test the full trick on the deployed URL.

## First real-phone test checklist

1. Open `/` on your phone, create a code, open your receiver, tap **Arm**.
2. On a second Android phone, open the native camera, point at the QR, tap the link chip. Allow the camera.
3. Shoot. Your phone should buzz within a second or two.
4. Tap → isolate. Hold and lift → pluck. Your phone double-buzzes.
5. Which exit worked? Try `?exit=camera` first; note whether it opened the camera, showed an app chooser, or did nothing.
6. Check the second phone's gallery: no new photo.
7. Touch your black screen: the photo grows out of your fingertip.

## Ideas / next

- Performer accounts so a code is tied to a person.
- Custom neutral domain (shorter QR, innocent link-chip text).
- iPhone support (exit via swipe home; no fullscreen).
