// LAN discovery check: two servers, one shared UDP port, and a real Join click.
//
// Discovery is the one feature whose failures are invisible from inside a
// single process: a beacon that never leaves, a row that never expires, a Join
// button wired to the wrong address. So this harness boots two real
// lan-servers with different HTTP ports on ONE shared discovery port, opens a
// browser on the first, and clicks the Join button the player would click.
//
// It drives the UI, not the API. Asserting `/net/discover` alone would pass
// happily while the panel drew nothing, which is exactly the class of bug this
// exists to catch.
//
// ## Why the beacons go out over broadcast, not loopback
//
// The design's `PLAYOPS_DISCOVERY_ADDR` override unicasts beacons at one
// address, which would keep this check off the network entirely. It cannot be
// used with a SHARED discovery port on macOS: libuv sets SO_REUSEPORT for UDP
// on Darwin, and Darwin delivers a unicast datagram on a reused port to
// exactly one of the sockets bound to it -- measured here as the
// first-bound socket receiving all ten of ten datagrams and the second
// receiving none. A broadcast to 255.255.255.255 IS delivered to every socket
// on the port, so that is what the shared-port check uses, and it exercises
// the real send path as a bonus.
//
// `--loopback` runs the same check the other way: two discovery ports,
// beacons unicast to 127.0.0.1, no datagram leaving the machine. That proves
// the override, and is the fallback on a machine with no usable interface.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';
import { createLanServer, lanAddresses } from '../server/lan-server.mjs';
import { BEACON_TTL_MS } from '../server/lan-discovery.mjs';

const root = process.cwd();
const artifactRoot = path.resolve(root, process.env.AI_GAME_ARTIFACT_DIR ?? 'artifacts/ai-discover');
const READY_TIMEOUT = 180000;

// Not 8010: a real game may be running on this Mac while this check does, and
// borrowing its port would put test beacons into somebody's lobby.
const DISCOVERY_PORT = Number(process.env.DISCOVER_PORT ?? 18010);

// Four times a second. The product beacons every two seconds; a check has no
// reason to wait that long, and a faster beacon makes the TTL drop-off
// observable inside a sensible timeout.
const BEACON_INTERVAL = 250;

const LOOPBACK = process.argv.includes('--loopback');

const BROWSER_CANDIDATES = [
  process.env.BROWSER_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function findBrowser() {
  return BROWSER_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate)) ?? null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask a server what it can see.
 *
 * `Connection: close` on purpose. A kept-alive socket left over from an
 * earlier poll goes stale while the browser phase runs for minutes, and the
 * next fetch on it fails with nothing wrong at either end -- which showed up
 * as a spurious failure of the TTL check.
 */
async function discover(port) {
  const response = await fetch(`http://127.0.0.1:${port}/net/discover`, {
    cache: 'no-store',
    headers: { connection: 'close' },
  });
  assert.equal(response.status, 200, `/net/discover on ${port} answered ${response.status}`);
  const body = await response.json();
  return { games: body.games ?? [], cors: response.headers.get('access-control-allow-origin') };
}

/** The games a server can see, or the empty list if it did not answer. */
async function games(port) {
  try {
    return (await discover(port)).games;
  } catch {
    return [];
  }
}

/** Poll until `predicate` holds, or give up. Returns the last value seen. */
async function until(label, predicate, read, timeoutMs = 6000, everyMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await read();
    if (predicate(last)) return { ok: true, value: last, waitedMs: timeoutMs - (deadline - Date.now()) };
    if (Date.now() >= deadline) return { ok: false, value: last, waitedMs: timeoutMs };
    await sleep(everyMs);
  }
}

/**
 * A peer, so the server has a game worth announcing.
 *
 * A beacon is only sent while the roster has somebody in it, so an idle server
 * is silent by design. The browser is that somebody for server A; B needs one
 * of its own before it appears in anybody's list.
 */
function joinAsPeer(wsUrl) {
  const socket = new WebSocket(wsUrl);
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', () => reject(new Error(`could not reach ${wsUrl}`)),
      { once: true });
  });
}

export async function runDiscoveryTest() {
  const checks = {};
  const errors = [];
  const check = (name, passed, detail = '') => {
    checks[name] = Boolean(passed);
    const line = `  ${passed ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`;
    process.stdout.write(`${line}\n`);
    if (!passed) errors.push(`${name}${detail ? `: ${detail}` : ''}`);
  };

  const browserPath = findBrowser();
  if (!browserPath) throw new Error('Chrome or Edge was not found. Set BROWSER_PATH to its executable.');
  await fs.promises.mkdir(artifactRoot, { recursive: true });

  // One shared discovery port in the broadcast mode this ships with; two ports
  // and a loopback unicast under --loopback. Both servers bind 0.0.0.0 so the
  // address a beacon is seen coming from is an address that answers.
  const shared = {
    host: '0.0.0.0',
    log: () => {},
    discovery: true,
    discoveryInterval: BEACON_INTERVAL,
  };
  const wiring = LOOPBACK
    ? [
      { discoveryPort: DISCOVERY_PORT, discoveryAddress: `127.0.0.1:${DISCOVERY_PORT + 1}` },
      { discoveryPort: DISCOVERY_PORT + 1, discoveryAddress: `127.0.0.1:${DISCOVERY_PORT}` },
    ]
    : [{ discoveryPort: DISCOVERY_PORT }, { discoveryPort: DISCOVERY_PORT }];

  const a = await createLanServer({ port: 0, ...shared, ...wiring[0] });
  const b = await createLanServer({ port: 0, ...shared, ...wiring[1] });
  const peers = [];
  let browser = null;
  const pages = [];
  const consoleLog = [];
  let result;

  process.stdout.write(`mode      ${LOOPBACK ? 'loopback unicast (two ports)' : 'broadcast (one shared port)'}\n`);
  process.stdout.write(`server A  http://127.0.0.1:${a.port}  beacon id ${a.discoveryId}\n`);
  process.stdout.write(`server B  http://127.0.0.1:${b.port}  beacon id ${b.discoveryId}\n`);
  process.stdout.write(`discovery ${a.discovery.port}${LOOPBACK ? ` / ${b.discovery.port}` : ' (shared)'}\n`);
  process.stdout.write(`LAN       ${lanAddresses().join(', ') || '(no non-internal IPv4 interface)'}\n\n`);

  try {
    check('bothServersListenOnTheDiscoveryPort',
      Boolean(a.discovery) && Boolean(b.discovery),
      'reuseAddr is what lets several games on one Mac all listen');
    if (!LOOPBACK) {
      check('theyShareOneDiscoveryPort', a.discovery.port === b.discovery.port,
        `${a.discovery.port} vs ${b.discovery.port}`);
    }
    check('theyServeDifferentHttpPorts', a.port !== b.port, `${a.port} vs ${b.port}`);

    // Silent while empty: nobody is offered a game with nobody in it.
    const quiet = await discover(a.port);
    check('anEmptyServerAnnouncesNothing', quiet.games.length === 0,
      JSON.stringify(quiet.games.map((game) => game.name)));
    check('discoverSendsCorsForAJoinedPage', quiet.cors === '*', String(quiet.cors));

    // Give each server a peer, which is what makes it a game worth listing.
    peers.push(await joinAsPeer(`ws://127.0.0.1:${a.port}/net`));
    peers.push(await joinAsPeer(`ws://127.0.0.1:${b.port}/net`));

    const seesOther = (port, otherId) => until(
      `${port} sees ${otherId}`,
      (games) => games.some((game) => game.id === otherId),
      () => games(port),
      3000,
    );

    const aSeesB = await seesOther(a.port, b.discoveryId);
    check('aFindsBWithinThreeSeconds', aSeesB.ok,
      `after ${aSeesB.waitedMs} ms A saw ${JSON.stringify(aSeesB.value.map((game) => game.id))}`);
    const bSeesA = await seesOther(b.port, a.discoveryId);
    check('bFindsAWithinThreeSeconds', bSeesA.ok,
      `after ${bSeesA.waitedMs} ms B saw ${JSON.stringify(bSeesA.value.map((game) => game.id))}`);

    const bRow = aSeesB.value.find((game) => game.id === b.discoveryId);
    process.stdout.write(`\n  A's list: ${JSON.stringify(aSeesB.value, null, 2)}\n\n`);
    check('theRowNamesBsHttpPortNotItsUdpOne', bRow?.port === b.port,
      `row says ${bRow?.port}, B serves ${b.port}`);
    check('theRowIsMarkedCompatible', bRow?.compatible === true, JSON.stringify(bRow?.compatible));
    check('neitherServerListsItself',
      !aSeesB.value.some((game) => game.id === a.discoveryId)
        && !bSeesA.value.some((game) => game.id === b.discoveryId),
      'your own game is the one you are already in');

    // The peers were only there to make the servers announce. From here the
    // browser is A's player, so drop the stand-in on A: its beacon has to be
    // able to stop when the browser leaves.
    peers.shift().close();

    browser = await chromium.launch({
      executablePath: browserPath,
      headless: process.env.AI_GAME_HEADED !== '1',
      args: [
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--use-angle=swiftshader',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    });

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    pages.push({ context, page });
    page.on('console', (message) => consoleLog.push(`[${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => {
      consoleLog.push(`[pageerror] ${error.message}`);
      errors.push(`page error: ${error.message}`);
    });

    // 40 MB of map through a software rasteriser; the default budget is short.
    // `autostart` stands in for the click on the welcome screen; without it the
    // page waits for a gesture and never begins loading the map.
    await page.goto(`http://127.0.0.1:${a.port}/?autostart=1`,
      { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(
      () => globalThis.hijacked?.debug?.getState?.().ready === true,
      undefined, { timeout: READY_TIMEOUT },
    );
    process.stdout.write('  browser: ready on server A\n');

    await page.waitForFunction(
      () => globalThis.hijacked.debug.getState().net?.connected === true,
      undefined, { timeout: 30000 },
    );
    const onA = await page.evaluate(() => globalThis.hijacked.debug.getState().net);
    check('theBrowserIsAPlayerOnA', onA.connected === true, `peer ${onA.peerId}`);

    // The row for B, drawn by the panel from its own poll of /net/discover.
    const row = page.locator(`.fe-lan-game[data-game-id="${b.discoveryId}"]`);
    await row.waitFor({ state: 'visible', timeout: 15000 });
    const rowText = (await row.textContent())?.replace(/\s+/g, ' ').trim();
    check('thePanelDrawsARowForB', Boolean(rowText), rowText);
    check('theRowHeadingIsThere',
      (await page.locator('.fe-lan-games[data-visible="true"] .fe-lan-games-title').count()) === 1,
      'Games on this WiFi');

    await page.screenshot({ path: path.join(artifactRoot, 'games-on-this-wifi.png') });
    const panelShot = path.join(artifactRoot, 'lan-panel.png');
    await page.locator('.fe-lan').screenshot({ path: panelShot });
    process.stdout.write(`  screenshot: ${panelShot}\n`);

    const joinButton = row.locator('.fe-lan-game-join');
    check('theRowOffersAJoinButton', (await joinButton.count()) === 1, rowText);

    // The real click, on the real button, with the mouse. Calling the action
    // directly would skip the wiring this check exists to prove.
    const beforeJoin = b.roster.size;
    await joinButton.click();
    process.stdout.write('  browser: clicked Join on B\n');

    const joinedRoster = await until(
      'B roster grows',
      (size) => size > beforeJoin,
      async () => b.roster.size,
      30000,
      200,
    );
    check('theBrowsersPeerAppearsInBsRoster', joinedRoster.ok,
      `B's roster went ${beforeJoin} -> ${joinedRoster.value} in ${joinedRoster.waitedMs} ms`);

    const joinedState = await page.evaluate(() => globalThis.hijacked.debug.getState());
    // Conclusive rather than circumstantial: the peer id the browser holds is
    // one B handed out, so the socket really did move to B's server.
    check('theBrowserIsNowConnectedToB',
      joinedState.net?.connected === true && b.roster.has(joinedState.net?.peerId),
      `browser holds ${joinedState.net?.peerId}, B's roster is `
        + JSON.stringify(b.roster.peers.map((peer) => peer.id)));
    check('thePanelSaysWhereYouArePlaying',
      Boolean(joinedState.lan?.joinedGame),
      JSON.stringify(joinedState.lan?.joinedGame));
    check('aIsNoLongerHoldingThisPlayer', a.roster.size === 0,
      `A's roster has ${a.roster.size}`);

    await page.screenshot({ path: path.join(artifactRoot, 'joined.png') });
    const backCount = await page.locator('.fe-lan-joined[data-visible="true"] .fe-lan-back').count();
    check('theWayBackIsOffered', backCount === 1, 'Back to my game');

    // A's roster is empty, so A must stop announcing and drop off B's list
    // within the TTL. This is the ghost-game invariant.
    const gone = await until(
      'A drops off B',
      (games) => !games.some((game) => game.id === a.discoveryId),
      () => games(b.port),
      BEACON_TTL_MS + 4000,
      250,
    );
    check('aBeaconStopsWhenItsPlayerLeaves', gone.ok,
      `after ${gone.waitedMs} ms B saw ${JSON.stringify(gone.value.map((game) => game.id))}`);
    check('aStoppedInsideTheTtl', gone.ok && gone.waitedMs <= BEACON_TTL_MS + 2000,
      `${gone.waitedMs} ms, TTL is ${BEACON_TTL_MS} ms`);

    check('noPageErrors', !consoleLog.some((line) => line.includes('pageerror')),
      consoleLog.filter((line) => line.includes('pageerror')).join(' | '));

    result = {
      command: 'lan-discover',
      mode: LOOPBACK ? 'loopback-unicast' : 'broadcast-shared-port',
      passed: errors.length === 0,
      checks,
      errors,
      discoveryPort: a.discovery.port,
      servers: { a: { http: a.port, id: a.discoveryId }, b: { http: b.port, id: b.discoveryId } },
      row: bRow,
      rowText,
      artifacts: artifactRoot,
    };
  } catch (error) {
    result = {
      command: 'lan-discover',
      mode: LOOPBACK ? 'loopback-unicast' : 'broadcast-shared-port',
      passed: false,
      checks,
      errors: [...errors, error instanceof Error ? error.stack : String(error)],
      artifacts: artifactRoot,
    };
  } finally {
    for (const socket of peers) {
      try {
        socket.close();
      } catch {
        // Already gone.
      }
    }
    for (const entry of pages) await entry.context.close().catch(() => {});
    await browser?.close().catch(() => {});
    await a.close().catch(() => {});
    await b.close().catch(() => {});
  }

  await fs.promises.writeFile(
    path.join(artifactRoot, 'console.log'), `${consoleLog.join('\n')}\n`, 'utf8');
  await fs.promises.writeFile(
    path.join(artifactRoot, 'report.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  process.stdout.write(`\n${result.passed ? 'PASSED' : 'FAILED'} — ${Object.keys(checks).length} checks, `
    + `${result.errors.length} problem(s)\n`);
  if (!result.passed) process.stdout.write(`${JSON.stringify(result.errors, null, 2)}\n`);
  process.stdout.write(`artifacts: ${artifactRoot}\n`);
  if (!result.passed) process.exitCode = 1;
  return result;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (invokedDirectly) await runDiscoveryTest();
