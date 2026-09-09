#!/usr/bin/env node
// Builds dist/PlayOps.dmg: a double-clickable Mac host for the LAN game.
//
// The problem this solves is social, not technical. Same-WiFi play needs one
// machine running the server, and "clone the repo and install Node" is not
// something anybody does at a party. So the server ships as one disk image
// containing one app bundle, and the host's whole job is to double-click it and
// read a QR code out to the room.
//
// The interesting part is that the app carries its own Node. Node's Single
// Executable Application feature appends a blob of JavaScript to a copy of the
// `node` binary and flips a fuse so that binary runs the blob instead of a
// REPL. Two consequences run through this file:
//
//   * The blob must be ONE CommonJS script, so the ESM server and its
//     dependencies are bundled with esbuild first. Nothing is left external:
//     the binary must run on a Mac that has never seen npm.
//   * A universal binary cannot be made by asking the local Node to be both
//     architectures. Instead the official darwin-arm64 and darwin-x64 tarballs
//     are downloaded, the blob is injected into each one's `node`, and `lipo`
//     welds the two results together. That is also why one CI runner suffices.
//
// Injecting a blob invalidates the Apple-issued signature on the downloaded
// binary, so the signature is removed before injection and an ad-hoc one is
// applied after `lipo`. Ad-hoc is not notarization: the host still has to click
// through Gatekeeper once, which README.txt explains.
//
// Run: npm run package:mac

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const NODE_CACHE = path.join(CACHE, 'node');
const WORK = path.join(CACHE, 'package-mac');
const WEB_SOURCE = path.join(ROOT, 'export', 'web');
const ICON_SOURCE = path.join(WEB_SOURCE, 'ui', 'menu_mp_map_select_hijacked_final.png');

/**
 * The fuse Node looks for to decide whether it has a blob appended. It is a
 * fixed string in Node's own source, not a value we get to choose: postject
 * overwrites the byte after it, and Node checks the same byte at startup. Get
 * it wrong and the binary silently behaves like plain `node`.
 */
export const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/** Mach-O wants the blob in a named segment; ELF and PE do not have this. */
export const MACHO_SEGMENT = 'NODE_SEA';

/** Both Mac architectures still in circulation. */
export const ARCHES = ['arm64', 'x64'];

export const BUNDLE_ID = 'in.ratrey.playops';
export const APP_NAME = 'PlayOps';
export const VOLUME_NAME = 'PlayOps';

/** Sizes an .icns needs. Finder, the Dock and Get Info each pick a different one. */
export const ICON_SIZES = [16, 32, 128, 256, 512];

const log = (line) => process.stdout.write(`${line}\n`);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...options,
  });
}

const rm = (target) => fs.rmSync(target, { recursive: true, force: true });
const mkdir = (target) => fs.mkdirSync(target, { recursive: true });

/** Bytes, formatted the way `ls -lh` would say it. */
export function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

export const tarballName = (version, arch) => `node-${version}-darwin-${arch}.tar.gz`;
export const tarballUrl = (version, arch) =>
  `https://nodejs.org/dist/${version}/${tarballName(version, arch)}`;

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * Download `url` to `file` unless it is already there.
 *
 * The cache is keyed by the exact filename, which includes the Node version, so
 * a version bump downloads afresh rather than silently reusing the old runtime.
 */
async function download(url, file) {
  if (fs.existsSync(file)) return { file, cached: true };
  mkdir(path.dirname(file));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  const temporary = `${file}.partial`;
  await fs.promises.writeFile(temporary, Buffer.from(await response.arrayBuffer()));
  // Renamed only once complete, so an interrupted download never poisons the
  // cache with a truncated runtime that fails much later with a confusing error.
  fs.renameSync(temporary, file);
  return { file, cached: false };
}

/**
 * The official tarball for one architecture, checksum-verified.
 *
 * The checksum matters more than usual here: whatever is in that tarball
 * becomes the executable we hand to friends and ask them to click past
 * Gatekeeper for.
 */
async function nodeTarball(version, arch) {
  const name = tarballName(version, arch);
  const file = path.join(NODE_CACHE, name);
  const { cached } = await download(tarballUrl(version, arch), file);
  const sums = path.join(NODE_CACHE, `SHASUMS256-${version}.txt`);
  await download(`https://nodejs.org/dist/${version}/SHASUMS256.txt`, sums);
  const line = fs.readFileSync(sums, 'utf8').split('\n')
    .find((entry) => entry.trim().endsWith(` ${name}`));
  if (!line) throw new Error(`${name} is not listed in SHASUMS256.txt for ${version}`);
  const expected = line.trim().split(/\s+/)[0];
  const actual = sha256(file);
  if (actual !== expected) {
    fs.rmSync(file, { force: true });
    throw new Error(`${name} checksum mismatch: ${actual} != ${expected} (removed)`);
  }
  log(`  ${name} ${cached ? '(cached)' : 'downloaded'}, sha256 ok`);
  return file;
}

/** Pull just `bin/node` out of a tarball; the rest is headers and npm. */
function extractNodeBinary(tarball, version, arch) {
  const into = path.join(WORK, `node-${arch}`);
  rm(into);
  mkdir(into);
  const member = `node-${version}-darwin-${arch}/bin/node`;
  run('tar', ['-xzf', tarball, '-C', into, member]);
  const binary = path.join(into, member);
  if (!fs.existsSync(binary)) throw new Error(`no ${member} in ${path.basename(tarball)}`);
  return binary;
}

/** One architecture's SEA: a copy of `node` with the blob welded in. */
function injectBlob(nodeBinary, blob, arch) {
  const target = path.join(WORK, `playops-server-${arch}`);
  fs.copyFileSync(nodeBinary, target);
  fs.chmodSync(target, 0o755);
  // Apple's signature covers the whole Mach-O, so appending to it makes the
  // signature invalid rather than merely stale. Removing it first keeps the
  // failure out of `codesign -v` later, where it would be much harder to read.
  run('codesign', ['--remove-signature', target]);
  run(process.execPath, [
    path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
    target, 'NODE_SEA_BLOB', blob,
    '--sentinel-fuse', SEA_FUSE,
    '--macho-segment-name', MACHO_SEGMENT,
  ]);
  return target;
}

/** Build the .icns Finder shows, from the map-select art the game already ships. */
function buildIcon(resources) {
  const iconset = path.join(WORK, `${APP_NAME}.iconset`);
  rm(iconset);
  mkdir(iconset);
  // The source is a 256x128 menu banner. An .icns must be square, so it is
  // scaled up to the largest size we need and padded rather than stretched —
  // a squashed icon reads as broken far more than a letterboxed one does.
  const master = path.join(WORK, 'icon-master.png');
  run('sips', ['-Z', '1024', ICON_SOURCE, '--out', master]);
  // sips prints the parsed pad colour to stderr; nobody needs to read that.
  run('sips', ['--padToHeightWidth', '1024', '1024', '--padColor', '0D0D12', master],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  for (const size of ICON_SIZES) {
    for (const scale of [1, 2]) {
      const pixels = size * scale;
      const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`;
      run('sips', ['-z', String(pixels), String(pixels), master,
        '--out', path.join(iconset, name)]);
    }
  }
  const icns = path.join(resources, `${APP_NAME}.icns`);
  run('iconutil', ['-c', 'icns', iconset, '-o', icns]);
  return icns;
}

/**
 * The launcher Finder actually runs.
 *
 * A bundle opened from Finder has no terminal, so a server started here would
 * print its banner into the void — and the banner, with its QR code, is the
 * entire point. `open -a Terminal <executable>` hands the binary to Terminal,
 * which gives the host a window to read and a window to close. Driving Terminal
 * with osascript would do the same thing but triggers an Automation permission
 * prompt, which is a worse first impression than a Gatekeeper click.
 */
export function launcherScript() {
  return `#!/bin/sh
# Hand the server to Terminal so the host can see the banner and the QR code.
here=$(cd "$(dirname "$0")" && pwd)
exec /usr/bin/open -a Terminal "$here/playops-server"
`;
}

export function infoPlist({ version }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>CFBundleIconFile</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.games</string>
</dict>
</plist>
`;
}

export function readmeText({ version }) {
  return `PlayOps ${version} — Claude of Duty, hosted from your Mac
=========================================================

Three steps
-----------
1. Drag PlayOps.app anywhere you like (Applications, the Desktop, wherever).
2. Double-click it. A Terminal window opens with a QR code in it.
3. Everyone else on the same WiFi scans that QR code, or types the LAN
   address printed above it. You play in the browser window that opens.

Closing that Terminal window stops hosting.

Two things macOS will ask you first
-----------------------------------
"PlayOps cannot be opened because it is from an unidentified developer."
    This app is signed, but not notarized by Apple — notarizing needs a paid
    Apple Developer account. Open System Settings > Privacy & Security, scroll
    to the bottom, and click "Open Anyway" next to PlayOps. You only do this
    once. (Right-click > Open works too.)

"Do you want the application playops-server to accept incoming network
connections?"
    Click Allow. Your friends cannot reach the game until you do — that prompt
    is macOS asking whether this Mac may act as a server on your network.

If nobody can connect
---------------------
* Everyone must be on the same WiFi. A guest network usually isolates devices
  from each other, so it will not work.
* Read out the "LAN" address from the Terminal window, not the "Local" one.
  "Local" (localhost) only ever means the machine you are sitting at.
* If you clicked Deny on the firewall prompt: System Settings > Network >
  Firewall > Options, and allow incoming connections for playops-server.

What is inside
--------------
The whole game and its own copy of Node, so nothing needs installing. It talks
to nobody outside your WiFi: no accounts, no telemetry, no internet needed
after the download.
`;
}

/** Assemble PlayOps.app around an already-universal, already-signed binary. */
function assembleApp(distDir, binary, version) {
  const app = path.join(distDir, `${APP_NAME}.app`);
  rm(app);
  const contents = path.join(app, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  mkdir(macos);
  mkdir(resources);

  fs.writeFileSync(path.join(contents, 'Info.plist'), infoPlist({ version }));
  fs.writeFileSync(path.join(macos, APP_NAME), launcherScript(), { mode: 0o755 });
  fs.copyFileSync(binary, path.join(macos, 'playops-server'));
  fs.chmodSync(path.join(macos, 'playops-server'), 0o755);

  buildIcon(resources);
  fs.writeFileSync(path.join(resources, 'README.txt'), readmeText({ version }));
  // ditto rather than cp: it is the tool that gets resource forks, symlinks and
  // permissions right on 179 MB of game assets, and it is considerably faster.
  log('  copying export/web (this is most of the image)');
  run('ditto', [WEB_SOURCE, path.join(resources, 'web')]);
  return app;
}

export async function packageMac({ distDir = path.join(ROOT, 'dist'), vendor = true } = {}) {
  if (process.platform !== 'darwin') {
    throw new Error(`package:mac needs macOS for lipo, sips and hdiutil (this is ${process.platform})`);
  }
  const version = process.version;
  const appVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  log(`PlayOps ${appVersion} — packaging with Node ${version} for ${ARCHES.join(' + ')}`);

  rm(WORK);
  mkdir(WORK);
  mkdir(distDir);

  if (vendor) {
    log('* vendoring browser dependencies');
    run(process.execPath, [path.join(ROOT, '.tools', 'vendor_deps.mjs')], { stdio: 'inherit' });
  }

  log('* bundling the server into one CommonJS file');
  const mainScript = path.join(WORK, 'playops-host.cjs');
  await esbuild({
    entryPoints: [path.join(ROOT, 'server', 'host-sea.mjs')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    // Nothing external. `ws`, `qrcode-terminal`, the discovery beacon and the
    // game's own net/protocol.js all go in, because the binary has to run on a
    // Mac with no node_modules anywhere near it.
    packages: 'bundle',
    // package.json is not on disk inside a SEA, so the version the discovery
    // beacon reports would be 0.0.0 unless it is baked in here.
    define: { 'globalThis.PLAYOPS_APP_VERSION': JSON.stringify(appVersion) },
    outfile: mainScript,
    logLevel: 'warning',
  });
  log(`  ${path.basename(mainScript)} ${humanSize(fs.statSync(mainScript).size)}`);

  log('* generating the SEA blob');
  const blob = path.join(WORK, 'playops-host.blob');
  const seaConfig = path.join(WORK, 'sea-config.json');
  fs.writeFileSync(seaConfig, `${JSON.stringify({
    main: mainScript,
    output: blob,
    disableExperimentalSEAWarning: true,
  }, null, 2)}\n`);
  run(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
  log(`  blob ${humanSize(fs.statSync(blob).size)}`);

  log('* fetching official Node runtimes');
  const injected = [];
  for (const arch of ARCHES) {
    const tarball = await nodeTarball(version, arch);
    injected.push(injectBlob(extractNodeBinary(tarball, version, arch), blob, arch));
  }

  log('* welding the two architectures into one universal binary');
  const universal = path.join(WORK, 'playops-server');
  rm(universal);
  run('lipo', ['-create', ...injected, '-output', universal]);
  fs.chmodSync(universal, 0o755);
  // Ad-hoc, because notarizing needs an Apple Developer account. Unsigned is
  // not an option: an unsigned arm64 binary is killed on launch, not merely
  // warned about.
  run('codesign', ['--force', '--sign', '-', universal]);
  log(`  ${run('lipo', ['-info', universal]).trim()}`);

  log('* assembling PlayOps.app');
  const app = assembleApp(distDir, universal, appVersion);
  // --deep so the nested playops-server is covered by the bundle's signature;
  // signing only the wrapper leaves the part Gatekeeper cares about unsigned.
  run('codesign', ['--force', '--deep', '--sign', '-', app]);
  run('codesign', ['-v', '--deep', app], { stdio: ['ignore', 'inherit', 'inherit'] });

  log('* building the disk image');
  const staging = path.join(WORK, 'dmg-root');
  rm(staging);
  mkdir(staging);
  run('ditto', [app, path.join(staging, `${APP_NAME}.app`)]);
  // Beside the app as well as inside it, so the Gatekeeper and firewall notes
  // are readable before anyone launches anything.
  fs.writeFileSync(path.join(staging, 'README.txt'), readmeText({ version: appVersion }));
  const dmg = path.join(distDir, `${APP_NAME}.dmg`);
  rm(dmg);
  run('hdiutil', ['create', '-volname', VOLUME_NAME, '-srcfolder', staging,
    '-ov', '-format', 'UDZO', '-quiet', dmg]);

  const size = fs.statSync(dmg).size;
  log('');
  log(`${path.relative(ROOT, dmg)}  ${humanSize(size)}`);
  return { app, dmg, size };
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const outIndex = process.argv.indexOf('--out');
  const distDir = outIndex > 0 ? path.resolve(process.argv[outIndex + 1]) : undefined;
  await packageMac({
    distDir,
    vendor: !process.argv.includes('--no-vendor'),
  });
}

export default packageMac;
