import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LanRoster } from '../server/lan-roster.mjs';
import { createLanServer } from '../server/lan-server.mjs';

// The host owns the bots and the match clock, so a host that stops simulating
// freezes the world for everyone while its socket stays perfectly healthy.
// Silence on the host-only channel is the only signal that tells the two apart.

test('promoteNext hands the role to the next-oldest peer', () => {
  const roster = new LanRoster();
  for (const name of ['a', 'b', 'c']) roster.join(name);
  assert.equal(roster.hostId, 'peer-1');
  assert.equal(roster.promoteNext(), 'peer-2');
  assert.equal(roster.hostId, 'peer-2');
});

test('a demoted host does not reclaim the role by recovering', () => {
  // Handing simulation back and forth between a struggling machine and a
  // healthy one is worse for the room than leaving it where it works.
  const roster = new LanRoster();
  for (const name of ['a', 'b', 'c']) roster.join(name);
  roster.promoteNext();
  assert.equal(roster.hostId, 'peer-2');
  roster.rename('peer-1', 'recovered');
  assert.equal(roster.hostId, 'peer-2', 'seniority must not win it back');
});

test('the demotion lapses when the peer holding it leaves', () => {
  const roster = new LanRoster();
  for (const name of ['a', 'b', 'c']) roster.join(name);
  roster.promoteNext();
  roster.leave('peer-2');
  // Election falls back to plain seniority, which may well be the peer that
  // was demoted earlier -- by then it is the best remaining option.
  assert.equal(roster.hostId, 'peer-1');
});

test('promoteNext keeps the host when there is nobody to promote', () => {
  const roster = new LanRoster();
  roster.join('alone');
  assert.equal(roster.promoteNext(), null);
  assert.equal(roster.hostId, 'peer-1', 'a match with no host is worse than a slow one');
});

/** Open a client and resolve once its `welcome` has arrived. */
async function connect(url, received) {
  const socket = new WebSocket(url);
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data);
    received.push(frame);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return socket;
}

const botState = JSON.stringify({ v: 1, t: 'botState', d: { t: 1, bots: [] } });
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a host that goes silent is replaced, and cannot take the role back', async () => {
  const lan = await createLanServer({
    port: 0, host: '127.0.0.1', log: () => {},
    hostSilenceMs: 250, hostWatchIntervalMs: 40,
  });
  try {
    const hostFrames = [];
    const guestFrames = [];
    const hostSocket = await connect(lan.wsUrl, hostFrames);
    const guestSocket = await connect(lan.wsUrl, guestFrames);
    await settle(60);
    assert.equal(lan.roster.hostId, 'peer-1');

    // It has to have hosted at least once before silence means anything.
    hostSocket.send(botState);
    await settle(80);
    assert.equal(lan.roster.hostId, 'peer-1', 'an active host is left alone');

    await settle(500);
    assert.equal(lan.roster.hostId, 'peer-2', 'a silent host is replaced');
    const announced = guestFrames.filter((frame) => frame.t === 'hostChanged');
    assert.ok(announced.length >= 1, 'the migration is announced');
    assert.equal(announced.at(-1).d.hostId, 'peer-2');

    // The recovered host is demoted, so its authority is refused at the relay
    // even though it still believes it is in charge.
    const droppedBefore = lan.stats.hostOnlyDropped;
    hostSocket.send(botState);
    await settle(120);
    assert.equal(lan.roster.hostId, 'peer-2');
    assert.equal(lan.stats.hostOnlyDropped, droppedBefore + 1,
      'the old host authoring bot state is dropped, not relayed');

    hostSocket.close();
    guestSocket.close();
  } finally {
    await lan.close();
  }
});

test('a host that has never broadcast is not demoted mid-load', async () => {
  // A freshly joined host spends a long time loading 40 MB of map before its
  // first botState. Replacing it then swaps it for someone equally not ready.
  const lan = await createLanServer({
    port: 0, host: '127.0.0.1', log: () => {},
    hostSilenceMs: 100, hostWatchIntervalMs: 30,
  });
  try {
    const frames = [];
    const a = await connect(lan.wsUrl, frames);
    const b = await connect(lan.wsUrl, frames);
    await settle(500);
    assert.equal(lan.roster.hostId, 'peer-1', 'still loading is not the same as gone');
    assert.equal(frames.filter((frame) => frame.t === 'hostChanged').length, 0);
    a.close();
    b.close();
  } finally {
    await lan.close();
  }
});

test('a lone host is never demoted, however quiet it is', async () => {
  const lan = await createLanServer({
    port: 0, host: '127.0.0.1', log: () => {},
    hostSilenceMs: 100, hostWatchIntervalMs: 30,
  });
  try {
    const frames = [];
    const only = await connect(lan.wsUrl, frames);
    only.send(botState);
    await settle(400);
    assert.equal(lan.roster.hostId, 'peer-1');
    only.close();
  } finally {
    await lan.close();
  }
});
