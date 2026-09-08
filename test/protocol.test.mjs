import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PROTOCOL_VERSION, MSG, HOST_ONLY, FLAG, LIMITS,
  encode, decode, validate,
  packVec3, packFlags, unpackFlags, roundCoordinate, roundAngle, sanitizeName,
  peerCombatantId, botCombatantId, isBotId,
} from '../export/web/net/protocol.js';

const hit = { target: 'peer-2', damage: 33, box: 'head' };

test('encode and decode round-trip a valid frame', () => {
  const frame = decode(encode(MSG.HIT, hit));
  assert.deepEqual(frame, { type: MSG.HIT, data: hit, from: null });
});

test('encode stamps sender identity when the server supplies it', () => {
  const frame = decode(encode(MSG.HIT, hit, 'peer-9'));
  assert.equal(frame.from, 'peer-9');
});

test('encode rejects an unknown type, because that is a programming error', () => {
  assert.throws(() => encode('nonsense', {}), /unknown message type/);
});

test('decode returns null rather than throwing on malformed input', () => {
  // Every one of these is reachable from a peer running a stale or broken
  // build, and none of them may take down the receiving client.
  for (const raw of ['{oops', '', 'null', '[]', '"a string"', undefined, 42, {}]) {
    assert.equal(decode(raw), null, `expected null for ${JSON.stringify(raw)}`);
  }
});

test('decode rejects a frame from a different protocol version', () => {
  assert.equal(decode(JSON.stringify({ v: PROTOCOL_VERSION + 1, t: MSG.HIT, d: hit })), null);
});

test('decode rejects an oversized frame before parsing it', () => {
  const huge = JSON.stringify({ v: PROTOCOL_VERSION, t: MSG.HIT, d: hit }) +
    ' '.repeat(LIMITS.MAX_FRAME_BYTES);
  assert.equal(decode(huge), null);
});

test('hit validation enforces the damage and hitbox bounds', () => {
  assert.ok(validate(MSG.HIT, hit));
  assert.ok(!validate(MSG.HIT, { ...hit, damage: LIMITS.MAX_DAMAGE + 1 }));
  assert.ok(!validate(MSG.HIT, { ...hit, damage: 0 }));
  assert.ok(!validate(MSG.HIT, { ...hit, damage: -5 }));
  assert.ok(!validate(MSG.HIT, { ...hit, damage: Number.NaN }));
  assert.ok(!validate(MSG.HIT, { ...hit, box: 'kneecap' }));
  assert.ok(!validate(MSG.HIT, { ...hit, target: '' }));
});

test('playerState validation rejects non-finite and out-of-range coordinates', () => {
  const base = {
    seq: 1, t: 10, pos: [1, 2, 3], yaw: 0, pitch: 0,
    flags: 0, health: 100, alive: true,
  };
  assert.ok(validate(MSG.PLAYER_STATE, base));
  assert.ok(!validate(MSG.PLAYER_STATE, { ...base, pos: [1, 2] }));
  assert.ok(!validate(MSG.PLAYER_STATE, { ...base, pos: [1, 2, Number.POSITIVE_INFINITY] }));
  assert.ok(!validate(MSG.PLAYER_STATE, { ...base, pos: [0, 0, LIMITS.MAX_COORDINATE * 2] }));
  assert.ok(!validate(MSG.PLAYER_STATE, { ...base, seq: 1.5 }));
  assert.ok(!validate(MSG.PLAYER_STATE, { ...base, alive: 'yes' }));
});

test('botState validation rejects unknown poses and oversized payloads', () => {
  const bot = { i: 0, pos: [0, 0, 0], yaw: 0, state: 'run', frame: 3, dead: false };
  assert.ok(validate(MSG.BOT_STATE, { t: 1, bots: [bot] }));
  assert.ok(!validate(MSG.BOT_STATE, { t: 1, bots: [{ ...bot, state: 'moonwalk' }] }));
  assert.ok(!validate(MSG.BOT_STATE, { t: 1, bots: [{ ...bot, frame: 0.5 }] }));
  const tooMany = Array.from({ length: LIMITS.MAX_BOTS + 1 }, () => bot);
  assert.ok(!validate(MSG.BOT_STATE, { t: 1, bots: tooMany }));
});

test('host-only messages are enumerated so the server can gate them', () => {
  assert.ok(HOST_ONLY.has(MSG.BOT_STATE));
  assert.ok(HOST_ONLY.has(MSG.MATCH_STATE));
  assert.ok(HOST_ONLY.has(MSG.SPAWN));
  assert.ok(!HOST_ONLY.has(MSG.PLAYER_STATE));
  assert.ok(!HOST_ONLY.has(MSG.HIT));
});

test('flags pack and unpack symmetrically', () => {
  const state = {
    crouched: true, sprinting: false, moving: true,
    firing: false, aiming: true, grounded: true,
  };
  assert.deepEqual(unpackFlags(packFlags(state)), state);
  assert.equal(packFlags({}), 0);
  assert.equal(packFlags(), 0);
  assert.equal(packFlags({ crouched: true }), FLAG.CROUCHED);
});

test('coordinates and angles round to the documented precision', () => {
  assert.equal(roundCoordinate(1234.56789), 1234.57);
  assert.equal(roundAngle(1.23456789), 1.2346);
  assert.deepEqual(packVec3({ x: 1.567, y: -2.9999, z: 0 }), [1.57, -3, 0]);
  // 1.005 * 100 is 100.49999999999999 in binary floating point, so it rounds
  // down. Positions are game units on a map thousands wide; a hundredth of a
  // unit either way is far below anything renderable.
  assert.deepEqual(packVec3({ x: 1.005, y: 0, z: 0 }), [1, 0, 0]);
});

test('names are clamped, uppercased, and stripped of control characters', () => {
  assert.equal(sanitizeName('alex'), 'ALEX');
  assert.equal(sanitizeName('  spaced   out  '), 'SPACED OUT');
  assert.equal(sanitizeName(''), 'PLAYER');
  assert.equal(sanitizeName(null), 'PLAYER');
  assert.equal(sanitizeName('a'.repeat(50)).length, LIMITS.MAX_NAME_LENGTH);
  // A name reaches the server's console and the scoreboard, so escapes and
  // newlines must not survive it.
  assert.equal(sanitizeName(`bo${String.fromCharCode(27)}[31mb`), 'BO [31MB');
  assert.equal(sanitizeName('one\ntwo'), 'ONE TWO');
});

test('combatant ids distinguish bots from people', () => {
  assert.equal(botCombatantId(3), 'bot-3');
  assert.equal(peerCombatantId('peer-7'), 'peer-7');
  assert.ok(isBotId('bot-0'));
  assert.ok(!isBotId('peer-0'));
  assert.ok(!isBotId('player'));
  assert.ok(!isBotId(undefined));
});
