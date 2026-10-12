# Gapless Amp

A Winamp-skinned MP3 player that installs to the iOS home screen, keeps the
music on the device, and plays albums with no gap between tracks.

- **Skins** — [Webamp](https://github.com/captbaritone/webamp) draws the UI. The
  default is the original Winamp 2.91 base skin; any classic `.wsz` can be loaded.
- **Gapless** — Webamp's own audio is replaced (`media.js`). A worker decodes
  MP3 with mpg123 (WASM), which trims each file's encoder delay and padding from
  its LAME header, and streams PCM to an AudioWorklet. Consecutive tracks are one
  unbroken stream.
- **Local** — files picked in the iOS file picker are copied into OPFS; track
  records and covers live in IndexedDB. Nothing is uploaded.
- **Organised by tags** — album, album artist, disc and track number come from
  ID3 (`tags.js`). File names are only a last resort for a missing title.

No build step. `vendor/` holds the browser builds of Webamp and mpg123-decoder,
copied from `node_modules` (`npm i` is only needed to refresh them or run tests).

## Run

    python3 serve.py 8080        # http://localhost:8080

## Test

    test/make-fixtures.sh        # needs ffmpeg + ImageMagick
    npm test                     # decoder gaplessness, tag parsing, album grouping

`test/e2e.playwright.js` is the same gapless check in a real browser, through
the whole app: import, play, record the output, compare with the source.

## Deploy

    ./deploy.sh                  # kichi, https://kichi.tailae45a.ts.net:8445 (tailnet only)

The service worker is cache-first with a background refresh, so the app opens
offline; a new build appears on the second launch after deploying.
