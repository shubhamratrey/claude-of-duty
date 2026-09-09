// Two-browser LAN check.
//
// Everything else in this repo can be proved with one page. LAN cannot: the
// interesting failures are disagreements BETWEEN machines — a body that only
// one side can see, damage that lands locally but never reaches the victim, a
// scoreboard that drifts. So this harness boots the real LAN server, opens two
// independent browser contexts against it, and asserts the two pages agree.
//
// Note that only one page can hold pointer lock at a time, so the shooting is
// driven through `hijacked.debug` rather than synthetic mouse input. That is a
// deliberate limit of testing two clients on one machine, not a shortcut.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';
import { createLanServer } from '../server/lan-server.mjs';

const root = process.cwd();
const artifactRoot = path.resolve(root, process.env.AI_GAME_ARTIFACT_DIR ?? 'artifacts/ai-lan');
const READY_TIMEOUT = 180000;

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

const state = (page) => page.evaluate(() => globalThis.hijacked.debug.getState());

/**
 * Stand in for a server this process did not start.
 *
 * Set `LAN_TARGET_URL` to run the whole two-browser check against a server
 * that is already listening -- the packaged PlayOps binary, most usefully. The
 * checks below only ever ask the server for a URL and, at the end, to shut
 * down; a server we do not own is simply left running. Unset, nothing changes:
 * the harness boots its own server on an ephemeral port as it always has.
 */
function attachToRunningServer(url) {
  const base = url.replace(/\/$/, '');
  return {
    url: base,
    wsUrl: `${base.replace(/^http/, 'ws')}/net`,
    external: true,
    async close() {},
  };
}

async function waitReady(page, label) {
  await page.waitForFunction(
    () => globalThis.hijacked?.debug?.getState?.().ready === true,
    undefined,
    { timeout: READY_TIMEOUT },
  );
  process.stdout.write(`  ${label}: ready\n`);
}

async function waitConnected(page, label) {
  await page.waitForFunction(
    () => globalThis.hijacked?.debug?.getState?.().net?.connected === true,
    undefined,
    { timeout: 30000 },
  );
  const net = (await state(page)).net;
  process.stdout.write(`  ${label}: ${net.peerId} (${net.role})\n`);
  return net;
}

/** Wait until this page has built a body for every other peer in the match. */
async function waitForRemoteBodies(page, expected, label) {
  await page.waitForFunction(
    (count) => (globalThis.hijacked?.debug?.getState?.().net?.remoteBodies?.length ?? 0) >= count,
    expected,
    { timeout: 30000 },
  );
  process.stdout.write(`  ${label}: sees ${expected} remote body/bodies\n`);
}

async function settle(page, frames = 12) {
  await page.evaluate(async (count) => {
    for (let i = 0; i < count; i += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, frames);
}

export async function runLanTest() {
  const checks = {};
  const errors = [];
  const check = (name, passed, detail = '') => {
    checks[name] = Boolean(passed);
    if (!passed) errors.push(`${name}${detail ? `: ${detail}` : ''}`);
  };

  const browserPath = findBrowser();
  if (!browserPath) throw new Error('Chrome or Edge was not found. Set BROWSER_PATH to its executable.');
  await fs.promises.mkdir(artifactRoot, { recursive: true });

  const lan = process.env.LAN_TARGET_URL
    ? attachToRunningServer(process.env.LAN_TARGET_URL)
    : await createLanServer({ port: 0, host: '127.0.0.1', log: () => {} });
  process.stdout.write(`LAN server on ${lan.url}${lan.external ? ' (already running)' : ''}\n`);

  const browser = await chromium.launch({
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

  const pages = [];
  const consoleLog = [];
  let result;

  try {
    // Separate contexts, not separate tabs: each needs its own localStorage and
    // its own socket, the way two laptops on the WiFi would.
    for (const label of ['host', 'guest']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await context.newPage();
      page.on('console', (message) => consoleLog.push(`[${label}:${message.type()}] ${message.text()}`));
      page.on('pageerror', (error) => {
        consoleLog.push(`[${label}:pageerror] ${error.message}`);
        errors.push(`${label} page error: ${error.message}`);
      });
      pages.push({ label, context, page });
    }

    // The host must join first: the server elects the oldest peer, so opening
    // them in order is what makes the roles predictable for this test.
    for (const { label, page } of pages) {
      // Two contexts pull the whole 40 MB map each, through a software
      // rasteriser. The default 30 s navigation budget is not enough.
      await page.goto(`${lan.url}?autostart=1`,
        { waitUntil: 'domcontentloaded', timeout: 120000 });
      await waitReady(page, label);
      await waitConnected(page, label);
      // Nothing simulates until the page believes it is being played: health,
      // spawn protection and the match clock all hang off the same gate.
      await page.evaluate(() => globalThis.hijacked.debug.setActive(true));
    }

    const [host, guest] = pages;
    const hostNet = (await state(host.page)).net;
    const guestNet = (await state(guest.page)).net;

    check('electsExactlyOneHost',
      hostNet.role === 'host' && guestNet.role === 'guest',
      `host=${hostNet.role} guest=${guestNet.role}`);
    check('peersAgreeOnHost', hostNet.hostId === guestNet.hostId,
      `${hostNet.hostId} vs ${guestNet.hostId}`);
    check('distinctPeerIds', hostNet.peerId !== guestNet.peerId);

    await waitForRemoteBodies(host.page, 1, 'host');
    await waitForRemoteBodies(guest.page, 1, 'guest');
    check('eachSeesTheOther', true);

    // Put the guest in front of the host and aim at its chest. Coordinates come
    // from the guest's own report, so this stays correct wherever it spawned.
    // Spawn protection lasts three seconds; firing through it would prove
    // nothing about whether damage crossed the wire.
    for (const { label, page } of pages) {
      // Protection burns three seconds of SIMULATED time, so a page rendering
      // slowly under a software rasteriser needs far longer than three seconds
      // of wall clock to get through it.
      await page.waitForFunction(
        () => globalThis.hijacked.debug.getState().player?.protected === false,
        undefined,
        { timeout: 90000 },
      );
      process.stdout.write(`  ${label}: spawn protection expired\n`);
    }

    // Stand them face to face on known-good ground.
    //
    // Spawns are random and Hijacked is a boat, so letting the two land where
    // they like produces a pair 1700 units apart with a bulkhead between them,
    // and sometimes a player still falling. A bot's position is guaranteed to
    // be on the navmesh and in the open, so both players are anchored to one:
    // the host on it, the guest a stride to the side of it.
    const anchor = await host.page.evaluate(() => {
      const bot = globalThis.hijacked.enemies?.enemies?.[0];
      if (!bot) return null;
      const p = bot.root.position;
      return [p.x, p.y, p.z];
    });
    check('hasABotToAnchorTo', Boolean(anchor));
    if (!anchor) throw new Error('no bot available to anchor the encounter');

    await host.page.evaluate(({ pos }) => {
      globalThis.hijacked.debug.teleportPlayer([pos[0], pos[1] + 60, pos[2]]);
    }, { pos: anchor });
    await host.page.waitForFunction(
      () => globalThis.hijacked.debug.getState().player?.grounded === true,
      undefined, { timeout: 60000 },
    ).catch(() => process.stdout.write('  host: never reported grounded\n'));
    await settle(host.page, 30);

    // Find a direction with a clear line of fire, rather than assuming one.
    //
    // Hijacked is a boat: railings, bulkheads and split deck levels mean a spot
    // 90 units to one side of a valid position is often behind cover or a
    // storey up. So try a ring of directions around the host and keep the first
    // one where the host's own ray actually reaches the body. That makes the
    // encounter self-verifying instead of dependent on where the two spawned.
    let resolved = null;
    const attempts = [];
    for (let attempt = 0; attempt < 6 && !resolved?.target; attempt += 1) {
      const spot = await host.page.evaluate(({ turn, distance }) => {
        const h = globalThis.hijacked;
        const feet = h.player.feetPosition;
        const forward = h.camera.getWorldDirection(h.camera.position.clone());
        const yaw = Math.atan2(forward.x, forward.z) + turn;
        return [
          feet.x + Math.sin(yaw) * distance,
          feet.y,
          feet.z + Math.cos(yaw) * distance,
        ];
      }, { turn: attempt * (Math.PI / 3), distance: 70 });

      await guest.page.evaluate(({ pos }) => {
        globalThis.hijacked.debug.teleportPlayer([pos[0], pos[1] + 60, pos[2]]);
      }, { pos: spot });
      await settle(guest.page, 25);

      // The host has to actually be drawing the body at the new spot before the
      // shot means anything; that lands a snapshot plus the interpolation delay
      // after the guest moved.
      await host.page.waitForFunction(({ peerId, pos }) => {
        const body = globalThis.hijacked.debug.getState().net.remoteBodies
          .find((entry) => entry.id === peerId);
        if (!body?.pos) return false;
        return Math.hypot(body.pos[0] - pos[0], body.pos[2] - pos[2]) < 70;
      }, { peerId: guestNet.peerId, pos: spot }, { timeout: 30000 })
        .catch(() => {});
      await settle(host.page, 15);

      // Aim and resolve in one evaluation, reading the body's live transform.
      // Splitting them aims at a stale position, because the body keeps
      // settling between the read and the shot.
      resolved = await host.page.evaluate(() => {
        const h = globalThis.hijacked;
        const actor = [...(h.enemies?.externalActors ?? [])][0];
        if (!actor) return { struck: null, target: null, reason: 'no remote actor' };
        const p = actor.root.position;
        h.debug.lookAt([p.x, p.y + 45, p.z]);
        const hit = h.weaponEffects.fire(h.camera, h.collisionRoot, h.viewmodel.muzzlePosition(),
          { targets: h.enemies?.hitTargets ?? [] });
        const report = h.enemies?.handlePlayerHit(hit, 1, { apply: false });
        return {
          struck: hit?.object?.name ?? (hit ? 'unnamed' : null),
          bodyAt: [p.x, p.y, p.z],
          eyeAt: [h.camera.position.x, h.camera.position.y, h.camera.position.z],
          target: report ? { id: report.id, kind: report.kind, region: report.region } : null,
        };
      });
      attempts.push({ turn: attempt, struck: resolved.struck, hit: resolved.target?.id ?? null });
      process.stdout.write(`  placement ${attempt}: struck ${resolved.struck} -> ${resolved.target?.id ?? 'nothing'}\n`);
    }

    process.stdout.write(`  eye ${JSON.stringify(resolved.eyeAt)} -> body ${JSON.stringify(resolved.bodyAt)}\n`);
    process.stdout.write(`  host ray struck ${resolved.struck} -> ${JSON.stringify(resolved.target)}\n`);
    check('lineOfFireReachesTheRemotePlayer',
      resolved.target?.id === guestNet.peerId,
      `tried ${attempts.length} placements: ${JSON.stringify(attempts)}`);

    await host.page.screenshot({ path: path.join(artifactRoot, 'host-aiming.png') });
    await guest.page.screenshot({ path: path.join(artifactRoot, 'guest-before.png') });

    const aimAndFire = () => host.page.evaluate(() => {
      const h = globalThis.hijacked;
      const actor = [...(h.enemies?.externalActors ?? [])][0];
      if (actor) {
        const p = actor.root.position;
        h.debug.lookAt([p.x, p.y + 45, p.z]);
      }
      return h.debug.fireOnce();
    });

    // Part one: damage crosses the wire.
    //
    // Two rounds is 66 damage, deliberately under the 100 that would kill. An
    // earlier version of this test fired six, killed the guest, and then read
    // its health AFTER it had respawned to full -- reporting "100 -> 100" while
    // the feature worked perfectly. Health is also regenerating, so this polls
    // quickly rather than settling and looking once.
    for (let i = 0; i < 2; i += 1) {
      await aimAndFire();
      await settle(host.page, 4);
    }
    let observedHealth = 100;
    const healthDeadline = Date.now() + 15000;
    while (Date.now() < healthDeadline) {
      observedHealth = (await state(guest.page)).player.health;
      if (observedHealth < 100) break;
      await settle(guest.page, 3);
    }
    check('remoteDamageReachesVictim', observedHealth < 100,
      `guest health stayed at ${observedHealth}`);

    // Part two: the kill completes the loop.
    //
    // This is the damage invariant end to end -- shooter reports, victim
    // confirms its own death, host records it, both scoreboards agree. Health
    // dropping only proves the first hop.
    for (let i = 0; i < 8; i += 1) {
      await aimAndFire();
      await settle(host.page, 3);
    }
    const killDeadline = Date.now() + 20000;
    let hostCredit = 0;
    let guestCredit = 0;
    while (Date.now() < killDeadline) {
      const [hs, gs] = await Promise.all([state(host.page), state(guest.page)]);
      const creditOn = (snapshot) => snapshot.match.standings
        .find((entry) => entry.id === hostNet.peerId)?.kills ?? 0;
      hostCredit = creditOn(hs);
      guestCredit = creditOn(gs);
      if (hostCredit >= 1 && guestCredit >= 1) break;
      await settle(guest.page, 5);
    }
    check('victimDeathIsScoredByTheHost', hostCredit >= 1,
      `host scoreboard credits ${hostCredit}`);
    check('bothScoreboardsAgreeOnTheKill', hostCredit === guestCredit,
      `host ${hostCredit} vs guest ${guestCredit}`);

    await host.page.screenshot({ path: path.join(artifactRoot, 'host-after-firing.png') });
    await guest.page.screenshot({ path: path.join(artifactRoot, 'guest-after-hit.png') });

    // Both pages must be drawing the same match, not two private ones.
    const hostMatch = (await state(host.page)).match;
    const guestMatch = (await state(guest.page)).match;
    const ids = (m) => m.standings.map((entry) => entry.id).sort();
    check('scoreboardsAgreeOnRoster',
      JSON.stringify(ids(hostMatch)) === JSON.stringify(ids(guestMatch)),
      `${JSON.stringify(ids(hostMatch))} vs ${JSON.stringify(ids(guestMatch))}`);
    check('bothPlayersAreOnTheScoreboard',
      ids(hostMatch).includes(hostNet.peerId) && ids(hostMatch).includes(guestNet.peerId),
      JSON.stringify(ids(hostMatch)));
    check('botsArePresentAlongsidePeople',
      hostMatch.standings.some((entry) => entry.id.startsWith('bot-')),
      JSON.stringify(ids(hostMatch)));

    // Only the host simulates bots; the guest must be replicating them, which
    // shows up as the two pages reporting bots in the same places.
    // Compare the two pages' bot positions at as near the same instant as two
    // browsers allow, and give the guest a chance to converge first. A single
    // arbitrary frame on a starved page measures scheduling noise, not
    // replication.
    let worstDrift = Infinity;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const [hostBots, guestBots] = await Promise.all([
        host.page.evaluate(() => globalThis.hijacked.debug.getState().enemies ?? []),
        guest.page.evaluate(() => globalThis.hijacked.debug.getState().enemies ?? []),
      ]);
      if (hostBots.length && guestBots.length) {
        worstDrift = Math.max(...hostBots.map((bot, index) => {
          const other = guestBots[index];
          if (!other) return Infinity;
          return Math.hypot(
            bot.position[0] - other.position[0],
            bot.position[2] - other.position[2],
          );
        }));
        if (worstDrift < 300) break;
      }
      await settle(guest.page, 10);
    }
    // A tenth of a second of interpolation delay at bot running speed is about
    // 25 units; 300 is loose enough for two browsers sharing one CPU, tight
    // enough to fail outright if replication is not happening at all.
    check('botsReplicateToTheGuest', worstDrift < 300, `worst drift ${worstDrift.toFixed(1)} units`);

    // Host migration: the room must survive the host walking away.
    //
    // The guest has never ticked the navmesh crowd, so this also covers the
    // handover -- if its agents were left stale the bots would snap somewhere
    // else, and if it never took over they would simply stop.
    const botsBefore = await guest.page.evaluate(
      () => (globalThis.hijacked.debug.getState().enemies ?? []).map((b) => b.position));
    await host.context.close();
    host.closed = true;

    await guest.page.waitForFunction(
      () => globalThis.hijacked.debug.getState().net?.role === 'host',
      undefined, { timeout: 30000 },
    ).catch(() => {});
    const promoted = (await state(guest.page)).net;
    check('survivingPeerIsPromotedToHost', promoted.role === 'host',
      `guest role is ${promoted.role}`);

    // Give the new host a moment, then confirm its bots are actually being
    // simulated rather than frozen at their last replicated transform.
    await settle(guest.page, 90);
    const botsAfter = await guest.page.evaluate(
      () => (globalThis.hijacked.debug.getState().enemies ?? []).map((b) => b.position));
    const moved = botsAfter.some((pos, index) => {
      const was = botsBefore[index];
      return was && Math.hypot(pos[0] - was[0], pos[2] - was[2]) > 1;
    });
    check('promotedHostSimulatesTheBots', moved,
      'no bot moved after promotion, so nobody is running the AI');

    const failedRequests = consoleLog.filter((line) => line.includes('requestfailed'));
    check('noPageErrors', !consoleLog.some((line) => line.includes('pageerror')));

    result = {
      command: 'lan-test',
      passed: errors.length === 0,
      checks,
      errors,
      host: hostNet,
      guest: guestNet,
      failedRequests,
      artifacts: artifactRoot,
    };
  } catch (error) {
    result = {
      command: 'lan-test',
      passed: false,
      checks,
      errors: [...errors, error instanceof Error ? error.stack : String(error)],
      artifacts: artifactRoot,
    };
  } finally {
    for (const entry of pages) if (!entry.closed) await entry.context.close().catch(() => {});
    await browser.close().catch(() => {});
    await lan.close().catch(() => {});
  }

  await fs.promises.writeFile(
    path.join(artifactRoot, 'console.log'), `${consoleLog.join('\n')}\n`, 'utf8');
  await fs.promises.writeFile(
    path.join(artifactRoot, 'report.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
  return result;
}

const invokedDirectly = process.argv[1] &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (invokedDirectly) await runLanTest();
