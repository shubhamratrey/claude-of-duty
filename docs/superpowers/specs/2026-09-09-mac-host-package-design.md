# Shareable Mac host package

**Date:** 2026-09-09 (IST)
**Status:** approved in chat, ready to build

## The problem

Same-WiFi play needs one machine running `npm run lan`. Today that means
cloning the repo and installing Node, which nobody at a party will do. The
public Netlify page cannot host a LAN game: an HTTPS page is forbidden by the
browser from opening a plain socket to a laptop on the network, and no
permission prompt changes that.

Everyone involved is on a Mac.

## What we ship

One zip, `PlayOps-mac.zip`, shared by AirDrop, a link, or a GitHub Release.
It unzips to a folder:

```
PlayOps-mac/
  PlayOps          universal Mach-O binary (arm64 + x86_64), the LAN server
  web/             the game (a copy of export/web, vendored deps included)
  README.txt       three steps, plus the Gatekeeper and firewall notes
```

Only the host needs the zip. Friends open a URL in their browser.

### Double-clicking `PlayOps`

macOS opens a Terminal window for a bare executable. In it the binary:

1. Finds `web/` next to `process.execPath`. If it is missing, prints a clear
   line saying the folder was moved apart and exits non-zero.
2. Starts the existing LAN server (`createLanServer`) on port 8000, serving
   `web/`. If 8000 is taken it tries the next few ports and says which one it
   took.
3. Prints the banner: the local URL, every LAN join URL, and a QR code of the
   first LAN join URL, large enough to scan across a table.
4. Opens the host's default browser at `http://localhost:<port>` via `open`.
5. Runs until the Terminal window is closed or Ctrl+C. Closing the window is
   the quit story; no menubar app, no window of our own.

The QR code is the point of the whole thing. Typing `192.168.10.183:8000` is
the friction that stops people; scanning is not.

## How it is built

`npm run package:mac` runs `.tools/package_mac.mjs`:

1. `npm run vendor` so `export/web/vendor/` is current.
2. Bundle `server/lan-server.mjs` plus a tiny entry (`server/host-entry.mjs`:
   locate web dir, pick port, banner, QR, `open`) into one CommonJS file with
   esbuild. Node's Single Executable Application (SEA) feature requires a
   single CommonJS script, and the server is ESM importing `ws` and
   `export/web/net/protocol.js`.
3. Generate the SEA blob with `node --experimental-sea-config`.
4. Fetch official Node tarballs for `darwin-arm64` and `darwin-x64` matching
   `process.version`, cache them under `.cache/node/`, and inject the blob into
   each `bin/node` with `postject` (`--macho-segment-name NODE_SEA`), after
   `codesign --remove-signature`.
5. `lipo -create` the two into one universal `PlayOps`, then ad-hoc sign it
   (`codesign -s -`). Verify with `lipo -info` and `codesign -v`.
6. Copy `export/web/` to `dist/PlayOps-mac/web/`. Exclude nothing the game
   needs; exclude nothing else either unless it is obviously dev-only and the
   saving is real.
7. Write `README.txt`. Zip with `ditto -c -k --keepParent` so executable bits
   survive, into `dist/PlayOps-mac.zip`. Print the final size.

New dev dependencies: `esbuild`, `postject`, `qrcode-terminal` (pure JS, is
bundled into the binary). No new runtime dependency for the web export.

`dist/` and `.cache/` stay ignored. The `.gitignore` is deny-all with an
allowlist; `.tools/package_mac.mjs`, `server/host-entry.mjs`,
`.github/workflows/package-mac.yml` and the tests are added to it.

### Release workflow

`.github/workflows/package-mac.yml` runs on a `v*` tag on `macos-14`: checkout,
`npm ci`, `npm run package:mac`, attach `dist/PlayOps-mac.zip` to the GitHub
Release for that tag. One runner is enough because both architectures are
built from downloaded tarballs, not from the runner's own Node.

## Frictions we accept and document in README.txt

- **Gatekeeper.** The binary is ad-hoc signed, not notarized. On first launch
  macOS refuses it; the user goes to System Settings → Privacy & Security →
  Open Anyway, once. Notarizing needs an Apple Developer account and is a
  separate decision.
- **Firewall.** macOS asks whether to allow incoming connections the first
  time. Friends cannot connect until the host clicks Allow.
- **Size.** Roughly 120–150 MB zipped: two copies of the Node runtime (~110 MB
  each uncompressed) plus 179 MB of game assets. Fine for AirDrop or a
  Release; too big to email.

## Testing

- `test/host-entry.test.mjs`: unit tests for the pure pieces — locating
  `web/` beside the executable, the port fallback sequence, banner text
  containing every LAN address, and the QR input being the first LAN URL.
  Import directly from the source, `node:assert/strict`, `node --test`, as the
  repo does everywhere else.
- `test/package-mac.test.mjs`: builds into a temp `dist`, then asserts
  `lipo -info` reports both `x86_64` and `arm64`, `codesign -v` passes, the
  zip contains `PlayOps-mac/PlayOps` and `PlayOps-mac/web/index.html`, and
  launching the unzipped binary from a *different* working directory answers
  `/net/health` with `lan: true` and `/index.html` with 200. Skipped when not
  on darwin or when network access to nodejs.org is unavailable, with the
  reason printed.
- Evidence for the report: the final `ls -la dist/`, the `lipo -info` line,
  the Terminal banner with the QR rendered, and a real join from a second
  browser to the packaged server (the existing `ai:lan` harness pointed at the
  packaged binary's port is the cheapest way).

## Out of scope, noted for later

- A QR code inside the game's LAN panel on the host's screen, so the host
  never has to leave the browser.
- Notarization.
- Windows or Linux packages.
- Auto-update or version checks.
