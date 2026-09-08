// Relay play, end to end, in two real browsers.
//
// The relay serves no game assets, so this needs two servers: a LAN server to
// hand out the page, and the relay to carry the sockets. That split is the
// point of the feature and it is what this exercises -- the page comes from one
// origin and talks to another, which is exactly what happens when someone loads
// the game from the public site and pastes a tunnel URL.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';
import { createLanServer } from '../server/lan-server.mjs';
import { createRelayServer } from '../server/relay-server.mjs';

const artifactRoot = path.resolve(process.cwd(), process.env.AI_GAME_ARTIFACT_DIR ?? 'artifacts/ai-relay');
const READY_TIMEOUT = 240000;

const BROWSERS = [
  process.env.BROWSER_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const findBrowser = () => BROWSERS.find((c) => c && fs.existsSync(c)) ?? null;

const state = (page) => page.evaluate(() => globalThis.hijacked.debug.getState());
const settle = (page, frames = 20) => page.evaluate(async (count) => {
  for (let i = 0; i < count; i += 1) await new Promise((r) => requestAnimationFrame(r));
}, frames);

export async function runRelayTest() {
  const checks = {};
  const errors = [];
  const check = (name, passed, detail = '') => {
    checks[name] = Boolean(passed);
    if (!passed) errors.push(`${name}${detail ? `: ${detail}` : ''}`);
  };

  const browserPath = findBrowser();
  if (!browserPath) throw new Error('Chrome or Edge was not found. Set BROWSER_PATH.');
  await fs.promises.mkdir(artifactRoot, { recursive: true });

  // The page host deliberately has no relay of its own, so nothing can pass by
  // accidentally falling back to the same-origin LAN path.
  const pageHost = await createLanServer({ port: 0, host: '127.0.0.1', log: () => {} });
  const relay = await createRelayServer({ port: 0, host: '127.0.0.1', log: () => {} });
  process.stdout.write(`page from ${pageHost.url}\nrelay at  ${relay.url}\n`);

  const browser = await chromium.launch({
    executablePath: browserPath,
    headless: process.env.AI_GAME_HEADED !== '1',
    args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });

  const pages = [];
  const consoleLog = [];
  let result;

  try {
    for (const label of ['host', 'guest']) {
      const context = await browser.newContext({ viewport: { width: 640, height: 400 } });
      const page = await context.newPage();
      page.on('console', (m) => consoleLog.push(`[${label}:${m.type()}] ${m.text()}`));
      page.on('pageerror', (e) => {
        consoleLog.push(`[${label}:pageerror] ${e.message}`);
        errors.push(`${label} page error: ${e.message}`);
      });
      await page.goto(`${pageHost.url}?autostart=1`,
        { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForFunction(
        () => globalThis.hijacked?.debug?.getState?.().ready === true,
        undefined, { timeout: READY_TIMEOUT });
      // Raise the shell so the panel is on screen and clickable. The relay
      // controls are only reachable from the title or pause screens.
      await page.evaluate(() => globalThis.hijacked.debug.showMenu(true));
      pages.push({ label, context, page });
      process.stdout.write(`  ${label}: loaded\n`);
    }
    const [host, guest] = pages;

    // Drive the real controls, not the API behind them.
    //
    // An earlier version of this called setRelayUrl() and restartNetSession()
    // directly and passed while the panel was completely inert: the shell was
    // dropping the value from every action it forwarded, so the mode button did
    // nothing. Clicking what a player clicks is the only version of this test
    // that means anything.
    const paste = async (page, url) => {
      const panel = page.locator('.fe-lan');
      await panel.waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('.fe-lan-mode[data-mode="relay"]').click();
      await page.waitForFunction(
        () => globalThis.hijacked.frontend.getLanState().mode === 'relay',
        undefined, { timeout: 5000 });
      const field = page.locator('#fe-relay-url');
      await field.fill(url);
      // The field commits on change, which is what a real blur produces.
      await field.press('Enter');
      await field.blur();
    };

    await paste(host.page, relay.url);
    await host.page.waitForFunction(
      () => Boolean(globalThis.hijacked.debug.getState().net?.roomCode),
      undefined, { timeout: 30000 });
    const code = (await state(host.page)).net.roomCode;
    process.stdout.write(`  host opened room ${code}\n`);
    check('pastingTheUrlOpensARoomAndGivesACode', /^[A-Z2-9]{4}$/.test(code ?? ''), String(code));

    // The second player pastes the same address and is asked for the code.
    await paste(guest.page, relay.url);
    await guest.page.waitForFunction(
      () => globalThis.hijacked.debug.getState().net?.roomRequired === true,
      undefined, { timeout: 30000 });
    const beforeJoin = await state(guest.page);
    check('secondPlayerIsAskedForTheCode', beforeJoin.net.roomRequired === true);
    check('secondPlayerIsNotGivenACodeOfItsOwn', !beforeJoin.net.roomCode,
      String(beforeJoin.net.roomCode));

    // A wrong code must be refused without dropping the connection. Typed into
    // the real field, which auto-submits on the fourth character.
    const wrong = code === 'ZZZZ' ? 'YYYY' : 'ZZZZ';
    const codeField = guest.page.locator('#fe-relay-code');
    await codeField.waitFor({ state: 'visible', timeout: 15000 });
    await codeField.fill(wrong);
    await codeField.press('Enter');
    await settle(guest.page, 30);
    const refused = await state(guest.page);
    check('aWrongCodeIsRefused', !refused.net.roomCode, String(refused.net.roomCode));
    check('aWrongCodeKeepsTheConnection', refused.net.connected === true);

    check('aWrongCodeIsReportedInThePanel',
      Boolean((await guest.page.evaluate(() => globalThis.hijacked.frontend.getLanState().joinError))),
      'the panel should say why');

    // The right code lets them in.
    await codeField.fill(code);
    await codeField.press('Enter');
    await guest.page.waitForFunction(
      () => Boolean(globalThis.hijacked.debug.getState().net?.roomCode),
      undefined, { timeout: 30000 });
    const joined = await state(guest.page);
    check('theRightCodeJoinsTheSameRoom', joined.net.roomCode === code,
      `${joined.net.roomCode} vs ${code}`);
    check('rolesAreAssigned',
      (await state(host.page)).net.role === 'host' && joined.net.role === 'guest');

    // And then it is an ordinary match.
    for (const { page } of pages) {
      await page.evaluate(() => {
        globalThis.hijacked.debug.showMenu(false);
        globalThis.hijacked.debug.setActive(true);
      });
    }
    for (const { label, page } of pages) {
      await page.waitForFunction(
        () => (globalThis.hijacked.debug.getState().net?.remoteBodies?.length ?? 0) >= 1,
        undefined, { timeout: 30000 })
        .catch(() => errors.push(`${label} never saw the other player`));
    }
    const hostNow = await state(host.page);
    const guestNow = await state(guest.page);
    check('theySeeEachOther',
      hostNow.net.remoteBodies.length >= 1 && guestNow.net.remoteBodies.length >= 1);
    const ids = (s) => s.match.standings.map((e) => e.id).sort();
    check('scoreboardsAgree', JSON.stringify(ids(hostNow)) === JSON.stringify(ids(guestNow)),
      `${JSON.stringify(ids(hostNow))} vs ${JSON.stringify(ids(guestNow))}`);
    check('botsAreInTheMatch', hostNow.match.standings.some((e) => e.id.startsWith('bot-')));

    await host.page.screenshot({ path: path.join(artifactRoot, 'host.png') });
    await guest.page.screenshot({ path: path.join(artifactRoot, 'guest.png') });

    check('noPageErrors', !consoleLog.some((line) => line.includes('pageerror')));

    result = {
      command: 'relay-test', passed: errors.length === 0, checks, errors,
      roomCode: code, relay: relay.url, page: pageHost.url, artifacts: artifactRoot,
    };
  } catch (error) {
    result = {
      command: 'relay-test', passed: false, checks,
      errors: [...errors, error instanceof Error ? error.stack : String(error)],
      artifacts: artifactRoot,
    };
  } finally {
    for (const entry of pages) await entry.context.close().catch(() => {});
    await browser.close().catch(() => {});
    await relay.close().catch(() => {});
    await pageHost.close().catch(() => {});
  }

  await fs.promises.writeFile(path.join(artifactRoot, 'console.log'), `${consoleLog.join('\n')}\n`);
  await fs.promises.writeFile(path.join(artifactRoot, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
  return result;
}

const invokedDirectly = process.argv[1] &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (invokedDirectly) await runRelayTest();
