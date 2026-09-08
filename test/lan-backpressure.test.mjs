import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  frameDisposition, DROPPABLE_TYPES, DROP_ABOVE_BYTES, DISCONNECT_ABOVE_BYTES,
} from '../server/lan-server.mjs';
import { MSG } from '../export/web/net/protocol.js';

// One stalled laptop must not slow the whole room down. A tab mid-GC or on weak
// hardware stops draining its socket, and without a policy the relay queues
// snapshots for it at 20 Hz forever -- spending the time it owes every other
// player on one client's backlog. These tests pin the rule that prevents it.

test('an idle socket sends everything', () => {
  for (const type of [MSG.PLAYER_STATE, MSG.BOT_STATE, MSG.HIT, MSG.DIED]) {
    assert.equal(frameDisposition(0, type), 'send', type);
  }
});

test('a congested socket drops snapshots, because the next one supersedes them', () => {
  const congested = DROP_ABOVE_BYTES + 1;
  for (const type of DROPPABLE_TYPES) {
    assert.equal(frameDisposition(congested, type), 'drop', type);
  }
});

test('a congested socket still receives events, which cannot be reconstructed', () => {
  const congested = DROP_ABOVE_BYTES + 1;
  // A hit, a death, or a join happened exactly once. Dropping one loses it for
  // good, so these are queued however far behind the peer has fallen.
  for (const type of [MSG.HIT, MSG.DIED, MSG.SPAWN, MSG.PEER_JOINED, MSG.PEER_LEFT,
    MSG.HOST_CHANGED, MSG.WELCOME, MSG.PONG]) {
    assert.equal(frameDisposition(congested, type), 'send', type);
  }
});

test('a hopeless socket is disconnected rather than carried', () => {
  const hopeless = DISCONNECT_ABOVE_BYTES + 1;
  // Past this the peer is not keeping up with even the reliable traffic.
  // Cutting it loose reclaims the memory and lets its own reconnect give it a
  // clean start, which serves everyone still playing far better.
  assert.equal(frameDisposition(hopeless, MSG.HIT), 'disconnect');
  assert.equal(frameDisposition(hopeless, MSG.PLAYER_STATE), 'disconnect');
});

test('the thresholds are boundaries, not off-by-one traps', () => {
  assert.equal(frameDisposition(DROP_ABOVE_BYTES, MSG.PLAYER_STATE), 'send');
  assert.equal(frameDisposition(DROP_ABOVE_BYTES + 1, MSG.PLAYER_STATE), 'drop');
  assert.equal(frameDisposition(DISCONNECT_ABOVE_BYTES, MSG.HIT), 'send');
  assert.equal(frameDisposition(DISCONNECT_ABOVE_BYTES + 1, MSG.HIT), 'disconnect');
});

test('the drop set is exactly the state snapshots', () => {
  // Guards the invariant directly: anything droppable must be a full snapshot
  // of current state. Adding an event type here would silently lose kills.
  assert.deepEqual([...DROPPABLE_TYPES].sort(),
    [MSG.BOT_STATE, MSG.MATCH_STATE, MSG.PLAYER_STATE, MSG.WEAPON_FIRE].sort());
});

test('a missing or junk bufferedAmount is treated as idle, never as hopeless', () => {
  // Some socket implementations do not report it. Guessing "congested" would
  // silently stop replicating for everyone.
  for (const value of [undefined, null, Number.NaN, 'lots']) {
    assert.equal(frameDisposition(value, MSG.PLAYER_STATE), 'send', String(value));
  }
});
