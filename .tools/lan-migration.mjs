// Three-player host migration.
//
// The two-page LAN check proves a host can be replaced. It cannot prove what
// happens to a BYSTANDER -- the third player who was neither the host nor the
// one promoted -- and that is where the interesting failures live: a scoreboard
// row nobody owns, bots that stop moving, two clients disagreeing about who is
// in charge.
//
// This caught exactly that. The server announces a departure before it
// announces the new host, so the peer about to be promoted saw the old host
// leave while still a guest, skipped dropping its combatant, and then
// published a scoreboard that kept the departed player forever.

import { chromium } from 'playwright-core';
import { createLanServer } from '../server/lan-server.mjs';

const lan = await createLanServer({ port: 0, host: '127.0.0.1', log: (m) => console.log(m) });
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const st = (p) => p.evaluate(() => globalThis.hijacked.debug.getState());
const settle = (p, n) => p.evaluate(async (c) => {
  for (let i = 0; i < c; i++) await new Promise(r => requestAnimationFrame(r));
}, n);

const pages = [];
for (const label of ['one', 'two', 'three']) {
  const context = await browser.newContext({ viewport: { width: 800, height: 480 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[${label} pageerror] ${e.message}`));
  await page.goto(`${lan.url}?autostart=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => globalThis.hijacked?.debug?.getState?.().ready === true, undefined, { timeout: 240000 });
  await page.evaluate(() => globalThis.hijacked.debug.setActive(true));
  const net = (await st(page)).net;
  console.log(`${label}: ${net.peerId} role=${net.role}`);
  pages.push({ label, context, page, peerId: net.peerId });
}
const [one, two, three] = pages;

// Let everyone see everyone.
await settle(two.page, 60); await settle(three.page, 60);
for (const p of pages) {
  const s = await st(p.page);
  console.log(`${p.label} sees bodies: ${JSON.stringify(s.net.remoteBodies.map(b => b.id))}  standings: ${JSON.stringify(s.match.standings.filter(e => e.human).map(e => e.id))}`);
}

// Give peer-1 a kill on the board so we can see whether score survives.
await one.page.evaluate(() => {
  const h = globalThis.hijacked;
  h.net.game.recordKill(h.net.localCombatantId, 'bot-0');
  h.net.broadcastMatch(true);
});
await settle(two.page, 30); await settle(three.page, 30);

const botsBefore = await three.page.evaluate(() => (globalThis.hijacked.debug.getState().enemies ?? []).map(b => b.position));

console.log('\n--- host (peer-1) closes its tab ---');
await one.context.close();

for (const p of [two, three]) {
  await p.page.waitForFunction(() => globalThis.hijacked.debug.getState().net?.hostId !== 'peer-1',
    undefined, { timeout: 30000 }).catch(() => console.log(`${p.label}: hostId never changed`));
}
await settle(two.page, 120); await settle(three.page, 120);

for (const p of [two, three]) {
  const s = await st(p.page);
  const humans = s.match.standings.filter(e => e.human);
  console.log(`\n${p.label} (${p.peerId}) after migration:`);
  console.log(`  role=${s.net.role} hostId=${s.net.hostId} connected=${s.net.connected}`);
  console.log(`  bodies drawn: ${JSON.stringify(s.net.remoteBodies.map(b => b.id))}`);
  console.log(`  human standings: ${JSON.stringify(humans.map(e => ({ id: e.id, kills: e.kills })))}`);
  console.log(`  GHOST peer-1 on scoreboard? ${humans.some(e => e.id === 'peer-1') ? 'YES' : 'no'}`);
}

const botsAfter = await three.page.evaluate(() => (globalThis.hijacked.debug.getState().enemies ?? []).map(b => b.position));
const moved = botsAfter.filter((p, i) => botsBefore[i] && Math.hypot(p[0]-botsBefore[i][0], p[2]-botsBefore[i][2]) > 1).length;
console.log(`\nbots moving for the bystander after migration: ${moved}/${botsAfter.length}`);

const failures = [];
const check = (name, passed, detail = '') => {
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
  if (!passed) failures.push(name);
};

console.log('\nchecks:');
const [twoState, threeState] = [await st(two.page), await st(three.page)];
const humansOn = (s) => s.match.standings.filter((e) => e.human).map((e) => e.id);

check('nextOldestPeerIsPromoted', twoState.net.role === 'host', `role ${twoState.net.role}`);
check('bystanderStaysAGuest', threeState.net.role === 'guest', `role ${threeState.net.role}`);
check('bothAgreeOnTheNewHost', twoState.net.hostId === threeState.net.hostId,
  `${twoState.net.hostId} vs ${threeState.net.hostId}`);
check('departedHostLeavesNoScoreboardGhost',
  !humansOn(twoState).includes('peer-1') && !humansOn(threeState).includes('peer-1'),
  JSON.stringify(humansOn(twoState)));
check('bothScoreboardsStillAgree',
  JSON.stringify(humansOn(twoState).sort()) === JSON.stringify(humansOn(threeState).sort()),
  `${JSON.stringify(humansOn(twoState))} vs ${JSON.stringify(humansOn(threeState))}`);
check('departedHostBodyIsRemoved',
  !twoState.net.remoteBodies.some((b) => b.id === 'peer-1') &&
  !threeState.net.remoteBodies.some((b) => b.id === 'peer-1'), '');
check('survivorsStillSeeEachOther',
  twoState.net.remoteBodies.some((b) => b.id === three.peerId) &&
  threeState.net.remoteBodies.some((b) => b.id === two.peerId), '');
check('promotedHostKeepsTheBotsRunningForTheBystander', moved > 0, `${moved}/${botsAfter.length} moved`);

console.log(failures.length ? `\nFAILED: ${failures.join(', ')}` : '\nAll checks passed.');
if (failures.length) process.exitCode = 1;

for (const p of pages.slice(1)) await p.context.close().catch(() => {});
await browser.close();
await lan.close();
