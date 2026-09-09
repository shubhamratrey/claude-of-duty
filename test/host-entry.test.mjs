// Unit tests for the pure pieces of the packaged Mac host.
//
// The binary itself cannot be unit tested cheaply: building it downloads two
// Node tarballs and takes minutes. So everything that can go wrong in the
// logic — finding the game next to a binary that has no __dirname, choosing a
// port when 8000 is taken, telling the host which URL to read out, and
// deciding whether popping a browser is appropriate — is a plain exported
// function with no side effects, and that is what is tested here.

import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { DISCOVERY_PORT } from '../server/lan-discovery.mjs';
import {
  DEFAULT_PORT,
  bonjourHostname,
  PORT_ATTEMPTS,
  hostBanner,
  listenOnFirstFreePort,
  locateWebDir,
  portSequence,
  qrTarget,
  renderQr,
  shouldOpenBrowser,
  webDirCandidates,
} from '../server/host-entry.mjs';

const BUNDLE_EXEC = '/Volumes/PlayOps/PlayOps.app/Contents/MacOS/playops-server';

/** An `exists` probe backed by a fixed set of directories. */
const existsIn = (...dirs) => {
  const set = new Set(dirs);
  return (candidate) => set.has(candidate);
};

test('locateWebDir finds web/ inside the app bundle from the executable path', () => {
  const resources = '/Volumes/PlayOps/PlayOps.app/Contents/Resources/web';
  assert.equal(locateWebDir(BUNDLE_EXEC, { exists: existsIn(resources) }), resources);
});

test('locateWebDir falls back to web/ beside the binary for a local run', () => {
  const beside = '/Users/someone/playops/web';
  assert.equal(
    locateWebDir('/Users/someone/playops/playops-server', { exists: existsIn(beside) }),
    beside,
  );
});

test('locateWebDir prefers the bundle layout when both exist', () => {
  const resources = '/Volumes/PlayOps/PlayOps.app/Contents/Resources/web';
  const beside = '/Volumes/PlayOps/PlayOps.app/Contents/MacOS/web';
  assert.equal(locateWebDir(BUNDLE_EXEC, { exists: existsIn(beside, resources) }), resources);
});

test('locateWebDir accepts extra candidates last, for running from a checkout', () => {
  const repo = '/Users/someone/claude-of-duty/export/web';
  assert.equal(
    locateWebDir('/usr/local/bin/node', { exists: existsIn(repo), extra: [repo] }),
    repo,
  );
});

test('locateWebDir returns null when the game is nowhere to be found', () => {
  assert.equal(locateWebDir(BUNDLE_EXEC, { exists: () => false }), null);
});

test('webDirCandidates are absolute and do not depend on the working directory', () => {
  for (const candidate of webDirCandidates(BUNDLE_EXEC)) {
    assert.ok(path.isAbsolute(candidate), `${candidate} is not absolute`);
  }
  assert.deepEqual(webDirCandidates(BUNDLE_EXEC), [
    '/Volumes/PlayOps/PlayOps.app/Contents/Resources/web',
    '/Volumes/PlayOps/PlayOps.app/Contents/MacOS/web',
  ]);
});

test('portSequence tries 8000 through 8009 by default', () => {
  assert.equal(DEFAULT_PORT, 8000);
  assert.equal(PORT_ATTEMPTS, 10);
  assert.deepEqual(portSequence(), [8000, 8001, 8002, 8003, 8004, 8005, 8006, 8007, 8008, 8009]);
});

test('portSequence starts wherever it is told and never repeats a port', () => {
  assert.deepEqual(portSequence(9000, 3), [9000, 9001, 9002]);
  assert.equal(new Set(portSequence(8000, 10)).size, 10);
});

test('the banner names the local URL and every LAN address', () => {
  const text = hostBanner({ port: 8003, addresses: ['192.168.10.183', '10.0.0.7'] });
  assert.match(text, /http:\/\/localhost:8003/);
  assert.match(text, /http:\/\/192\.168\.10\.183:8003/);
  assert.match(text, /http:\/\/10\.0\.0\.7:8003/);
  // The host has to know which line to read out to the room.
  assert.match(text, /share this/i);
  // And how to stop hosting, since closing the window is the only control.
  assert.match(text, /Ctrl\+C|close this window/i);
});

test('the banner says so plainly when there is no LAN interface', () => {
  const text = hostBanner({ port: 8000, addresses: [] });
  assert.match(text, /http:\/\/localhost:8000/);
  assert.match(text, /no .*IPv4|not on a network|check the WiFi/i);
  assert.doesNotMatch(text, /http:\/\/undefined/);
});

test('the QR code encodes the first LAN URL, not localhost', () => {
  assert.equal(
    qrTarget({ port: 8000, addresses: ['192.168.10.183', '10.0.0.7'] }),
    'http://192.168.10.183:8000',
  );
});

test('there is nothing to scan without a LAN address', () => {
  assert.equal(qrTarget({ port: 8000, addresses: [] }), null);
});

test('renderQr produces a scannable block, not a URL echo', () => {
  const block = renderQr('http://192.168.10.183:8000');
  const lines = block.split('\n');
  // A version-3 QR of a join URL is 29 modules plus a quiet zone. Rendered one
  // module per row it is at least 25 rows tall; anything much shorter means the
  // code was echoed as text rather than drawn.
  assert.ok(lines.length >= 25, `only ${lines.length} rows of QR`);
  // Two terminal cells per module, so it is wide enough to scan across a table.
  assert.match(block, /\u001b\[47m {2}/, 'QR modules are not being drawn as filled cells');
  assert.doesNotMatch(block, /192\.168\.10\.183/);
});

test('the browser is opened for an interactive host', () => {
  assert.equal(shouldOpenBrowser({ isTTY: true, env: {} }), true);
});

test('the browser is left alone for tests and for non-interactive runs', () => {
  assert.equal(shouldOpenBrowser({ isTTY: false, env: {} }), false);
  assert.equal(shouldOpenBrowser({ isTTY: true, env: { PLAYOPS_NO_OPEN: '1' } }), false);
  assert.equal(shouldOpenBrowser({ isTTY: true, env: { CI: 'true' } }), false);
});

// A friendlier alternative to reading out four numbers and a colon. macOS
// publishes `<hostname>.local` over Bonjour, and every Mac, iPhone and iPad on
// the WiFi resolves it without any configuration.

test('bonjourHostname lowercases a plain hostname and adds .local', () => {
  assert.equal(bonjourHostname('shubhams-macbook'), 'shubhams-macbook.local');
});

test('bonjourHostname does not double up a name that already ends in .local', () => {
  assert.equal(bonjourHostname('shubhams-macbook.local'), 'shubhams-macbook.local');
  assert.equal(bonjourHostname('Shubhams-MacBook.Local'), 'shubhams-macbook.local');
});

test('bonjourHostname normalises mixed case and a trailing dot', () => {
  assert.equal(bonjourHostname('Shubhams-MacBook-Pro'), 'shubhams-macbook-pro.local');
  assert.equal(bonjourHostname('Shubhams-MacBook.local.'), 'shubhams-macbook.local');
});

test('bonjourHostname gives up on a hostname there is nothing to publish', () => {
  assert.equal(bonjourHostname(''), null);
  assert.equal(bonjourHostname('   '), null);
  assert.equal(bonjourHostname(null), null);
  assert.equal(bonjourHostname('.local'), null);
  // Omitting the argument means "this Mac", which is the useful default.
  assert.match(bonjourHostname(), /^[^.]+.*\.local$/);
});

test('the banner offers the .local name alongside the numeric LAN URL', () => {
  const text = hostBanner({
    port: 8000,
    addresses: ['192.168.10.183'],
    hostname: 'Shubhams-MacBook',
  });
  assert.match(text, /http:\/\/shubhams-macbook\.local:8000/);
  assert.match(text, /http:\/\/192\.168\.10\.183:8000/);
});

test('the banner does not advertise a .local name with no network behind it', () => {
  const text = hostBanner({ port: 8000, addresses: [], hostname: 'Shubhams-MacBook' });
  assert.doesNotMatch(text, /\.local/);
});

test('the QR code still encodes the numeric LAN URL, not the .local name', () => {
  assert.equal(
    qrTarget({ port: 8000, addresses: ['192.168.10.183'], hostname: 'Shubhams-MacBook' }),
    'http://192.168.10.183:8000',
  );
});

test('a busy port is stepped over rather than reported to the host', async (t) => {
  // A real listener, because the failure mode this covers is not the EADDRINUSE
  // itself but who hears about it: ws re-emits the HTTP server's errors, and an
  // unhandled one there kills the process before any fallback can run.
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const busy = blocker.address().port;
  t.after(() => new Promise((resolve) => blocker.close(resolve)));

  const lan = await listenOnFirstFreePort([busy, busy + 1, busy + 2], {
    // A unit test has no business binding the shared discovery port; the
    // packaged host turns it on, and test/lan-discovery.test.mjs proves it.
    host: '127.0.0.1', log: () => {}, discovery: false,
  });
  t.after(() => lan.close());
  assert.notEqual(lan.port, busy);
  assert.ok(lan.port > busy && lan.port <= busy + 2, `landed on ${lan.port}`);
});

test('every port being taken is reported, not retried forever', async () => {
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const busy = blocker.address().port;
  try {
    await assert.rejects(
      listenOnFirstFreePort([busy], { host: '127.0.0.1', log: () => {}, discovery: false }),
      /in use/,
    );
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

// Discovery is what makes the packaged app worth double-clicking twice: the
// second Mac on the WiFi lists the first one's game without anybody reading an
// address out. The banner has to say it is running, both so the host knows and
// so the macOS local-network prompt that follows makes sense.

test('the banner names the discovery port when the beacon is running', () => {
  const text = hostBanner({
    port: 8000,
    addresses: ['192.168.10.183'],
    discovery: { port: DISCOVERY_PORT },
  });
  assert.match(text, /Discover UDP 8010/);
  assert.match(text, /this WiFi/i);
  // The address to read out still comes first: discovery is the shortcut, not
  // the only way in.
  assert.ok(text.indexOf('192.168.10.183') < text.indexOf('Discover'),
    'the shareable address must stay above the discovery note');
});

test('the banner stays silent about discovery when it is switched off', () => {
  const text = hostBanner({ port: 8000, addresses: ['192.168.10.183'], discovery: null });
  assert.doesNotMatch(text, /Discover|UDP/i);
});

test('a host started with no options announces itself on the WiFi', async (t) => {
  // The packaged app passes no flags at all, so the default has to be "on".
  // Unicast to loopback on a port of this repo's own choosing, so the check
  // costs the WiFi nothing.
  const lan = await listenOnFirstFreePort([0], {
    host: '127.0.0.1',
    log: () => {},
    discoveryPort: 18098,
    discoveryAddress: '127.0.0.1',
    discoveryInterval: 60000,
  });
  t.after(() => lan.close());
  assert.ok(lan.discovery, 'discovery is on with no options set');
  assert.equal(lan.discovery.port, 18098);
  assert.match(hostBanner({ port: lan.port, addresses: [], discovery: lan.discovery }),
    /Discover UDP 18098/);
});
