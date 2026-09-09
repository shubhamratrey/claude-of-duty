// Does the shipped disk image actually host a game?
//
// Every other test in this repo runs the server from the checkout, where
// `import.meta.url`, `node_modules` and `export/web` all exist. The packaged
// binary has none of those: it is one Mach-O file with the script inside it,
// launched by Finder from whatever working directory Finder felt like. The
// failures that live only in that gap — a path resolved from `__dirname`, a
// dependency left external, a blob injected with the wrong segment name — are
// invisible until something runs the real artifact. So this builds it and runs
// it.
//
// It is slow (a few minutes, ~200 MB of output) and is deliberately not in
// `npm run test:unit`.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TARBALL_CACHE = path.join(ROOT, '.cache', 'node');
const BUILD_TIMEOUT_MS = 900000;

/** The tarballs the build needs, if they are already on disk. */
const tarballsCached = () => ['arm64', 'x64'].every((arch) =>
  fs.existsSync(path.join(TARBALL_CACHE, `node-${process.version}-darwin-${arch}.tar.gz`)));

async function reachable(url) {
  try {
    const response = await fetch(url, {
      method: 'HEAD', signal: AbortSignal.timeout(8000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Why this test cannot run here, or null if it can. */
async function skipReason() {
  if (process.platform !== 'darwin') {
    return `needs macOS for lipo, codesign and hdiutil (this is ${process.platform})`;
  }
  if (tarballsCached()) return null;
  if (!(await reachable(`https://nodejs.org/dist/${process.version}/SHASUMS256.txt`))) {
    return `nodejs.org is unreachable and ${process.version} tarballs are not cached`;
  }
  return null;
}

const sh = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Read a growing log until it matches, so a slow start is waited out, not raced. */
async function waitForLog(file, pattern, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (pattern.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`never matched ${pattern} in ${file}; saw:\n${text}`);
}

test('the packaged app hosts the game from a mounted disk image', async (t) => {
  const reason = await skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const { packageMac } = await import('../.tools/package_mac.mjs');
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playops-dist-'));
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'playops-mount-'));
  let attached = false;
  let child = null;
  t.after(() => {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    if (attached) {
      try { sh('hdiutil', ['detach', '-quiet', mountPoint]); } catch { /* already gone */ }
    }
    fs.rmSync(distDir, { recursive: true, force: true });
    fs.rmSync(mountPoint, { recursive: true, force: true });
  });

  // `vendor: false` because export/web/vendor is a checkout-wide artifact; a
  // test should not rewrite the working tree to make its point.
  const { app, dmg, size } = await packageMac({ distDir, vendor: false });
  assert.ok(size > 50 * 1024 * 1024, `image is only ${size} bytes`);

  const binary = path.join(app, 'Contents', 'MacOS', 'playops-server');
  const architectures = sh('lipo', ['-info', binary]);
  assert.match(architectures, /x86_64/);
  assert.match(architectures, /arm64/);

  // --deep so the verdict covers the nested binary and not just the wrapper.
  sh('codesign', ['-v', '--deep', app]);

  sh('hdiutil', ['attach', '-nobrowse', '-quiet', '-mountpoint', mountPoint, dmg]);
  attached = true;
  const mountedApp = path.join(mountPoint, 'PlayOps.app');
  const mountedBinary = path.join(mountedApp, 'Contents', 'MacOS', 'playops-server');
  assert.ok(fs.existsSync(mountedBinary), 'no playops-server on the mounted image');
  assert.ok(fs.existsSync(path.join(mountedApp, 'Contents', 'Resources', 'web', 'index.html')),
    'no web/index.html on the mounted image');
  assert.ok(fs.existsSync(path.join(mountPoint, 'README.txt')),
    'the Gatekeeper and firewall notes are not visible beside the app');

  // The working directory is deliberately somewhere else entirely: Finder
  // launches apps from `/`, and a server that resolved `web/` relative to cwd
  // would pass every other test in this repo and fail on a friend's Mac.
  const logFile = path.join(distDir, 'run.log');
  const logHandle = fs.openSync(logFile, 'w');
  const port = 8300 + (process.pid % 200);
  child = spawn(mountedBinary, [], {
    cwd: os.homedir(),
    env: { ...process.env, PORT: String(port), PLAYOPS_NO_OPEN: '1' },
    stdio: ['ignore', logHandle, logHandle],
  });

  const banner = await waitForLog(logFile, /Scan to join: http:\/\/|no QR code/);
  assert.match(banner, /PlayOps — Claude of Duty LAN host/);
  assert.match(banner, new RegExp(`http://localhost:${port}`));

  const health = await fetch(`http://127.0.0.1:${port}/net/health`);
  assert.equal(health.status, 200);
  const info = await health.json();
  assert.equal(info.lan, true);

  const page = await fetch(`http://127.0.0.1:${port}/index.html`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);
}, { timeout: BUILD_TIMEOUT_MS });
