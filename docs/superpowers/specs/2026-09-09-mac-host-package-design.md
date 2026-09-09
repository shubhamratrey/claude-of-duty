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

One disk image, `PlayOps.dmg`, shared by AirDrop, a link, or a GitHub
Release. Opening it shows one thing to drag anywhere, or run in place:

```
PlayOps.app/
  Contents/
    Info.plist               CFBundleExecutable=PlayOps, CFBundleIconFile=PlayOps
    MacOS/
      PlayOps                launcher shell script (see below)
      playops-server         universal Mach-O binary (arm64 + x86_64), the LAN server
    Resources/
      PlayOps.icns           icon made from ui/menu_mp_map_select_hijacked_final.png
      web/                   the game (a copy of export/web, vendored deps included)
      README.txt             three steps, plus the Gatekeeper and firewall notes
```

The dmg also carries a `README.txt` beside the app so the notes are visible
before anyone launches anything.

Only the host needs the dmg. Friends open a URL in their browser.

### Double-clicking `PlayOps.app`

An app bundle launched from Finder has no Terminal, so the launcher script
`Contents/MacOS/PlayOps` does exactly one thing: `open -a Terminal` on the
sibling `playops-server` binary. That gives the host a Terminal window showing
the banner, and closing that window is how they stop hosting. (`osascript`
driving Terminal is avoided on purpose: it triggers an Automation permission
prompt; `open -a Terminal <executable>` does not.)

In that Terminal the binary:

1. Finds `web/` at `../Resources/web` relative to `process.execPath`. If it is
   missing, prints a clear line and exits non-zero.
2. Starts the existing LAN server (`createLanServer`) on port 8000, serving
   `web/`. If 8000 is taken it tries the next few ports and says which one it
   took.
3. Prints the banner: the local URL, every LAN join URL, and a QR code of the
   first LAN join URL, large enough to scan across a table.
4. Opens the host's default browser at `http://localhost:<port>` via `open`.
5. Runs until the Terminal window is closed or Ctrl+C.

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
6. Assemble `dist/PlayOps.app` as laid out above. Copy `export/web/` to
   `Contents/Resources/web/`. Exclude nothing the game needs; exclude nothing
   else either unless it is obviously dev-only and the saving is real.
7. Make `PlayOps.icns` from `export/web/ui/menu_mp_map_select_hijacked_final.png`
   with `sips` (each iconset size) and `iconutil -c icns`. Write `Info.plist`
   (bundle id `in.ratrey.playops`, version from `package.json`). Ad-hoc sign
   the whole bundle (`codesign -s - --deep`).
8. Write `README.txt` into `Contents/Resources/` and beside the app in the dmg
   staging folder. Build the image with
   `hdiutil create -volname PlayOps -srcfolder <staging> -ov -format UDZO
   dist/PlayOps.dmg`. Print the final size.

New dev dependencies: `esbuild`, `postject`, `qrcode-terminal` (pure JS, is
bundled into the binary). No new runtime dependency for the web export.

`dist/` and `.cache/` stay ignored. The `.gitignore` is deny-all with an
allowlist; `.tools/package_mac.mjs`, `server/host-entry.mjs`,
`.github/workflows/package-mac.yml` and the tests are added to it.

### Release workflow

`.github/workflows/package-mac.yml` runs on a `v*` tag on `macos-14`: checkout,
`npm ci`, `npm run package:mac`, attach `dist/PlayOps.dmg` to the GitHub
Release for that tag. One runner is enough because both architectures are
built from downloaded tarballs, not from the runner's own Node.

## Frictions we accept and document in README.txt

- **Gatekeeper.** The binary is ad-hoc signed, not notarized. On first launch
  macOS refuses it; the user goes to System Settings → Privacy & Security →
  Open Anyway, once. Notarizing needs an Apple Developer account and is a
  separate decision.
- **Firewall.** macOS asks whether to allow incoming connections the first
  time. Friends cannot connect until the host clicks Allow.
- **Size.** Roughly 120–150 MB compressed: two copies of the Node runtime
  (~110 MB each uncompressed) plus 179 MB of game assets. Fine for AirDrop or a
  Release; too big to email.

## Testing

- `test/host-entry.test.mjs`: unit tests for the pure pieces — locating
  `web/` from the executable path (bundle layout, and a plain
  `web/`-beside-binary fallback for local runs), the port fallback sequence, banner text
  containing every LAN address, and the QR input being the first LAN URL.
  Import directly from the source, `node:assert/strict`, `node --test`, as the
  repo does everywhere else.
- `test/package-mac.test.mjs`: builds into a temp `dist`, then asserts
  `lipo -info` on `playops-server` reports both `x86_64` and `arm64`,
  `codesign -v` passes on the bundle, `hdiutil attach` of the dmg exposes
  `PlayOps.app/Contents/MacOS/playops-server` and
  `PlayOps.app/Contents/Resources/web/index.html` (detach afterwards), and
  launching the binary from the mounted image, from a *different* working
  directory, answers `/net/health` with `lan: true` and `/index.html` with
  200. Skipped when not
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
