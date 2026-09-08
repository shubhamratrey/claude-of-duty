import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RoomSlot, RelayRoom, generateRoomCode } from '../server/relay-room.mjs';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, isRoomCode } from '../export/web/net/protocol.js';

test('codes avoid the characters people mishear', () => {
  // I/O/0/1 are excluded because codes get read out over voice chat.
  for (const banned of ['I', 'O', '0', '1']) {
    assert.ok(!ROOM_CODE_ALPHABET.includes(banned), `alphabet must not contain ${banned}`);
  }
  for (let i = 0; i < 200; i += 1) {
    const code = generateRoomCode();
    assert.equal(code.length, ROOM_CODE_LENGTH);
    assert.ok(isRoomCode(code), `${code} should be a valid code`);
  }
});

test('a new code is never the one just released', () => {
  for (let i = 0; i < 200; i += 1) {
    assert.notEqual(generateRoomCode('ABCD'), 'ABCD');
  }
});

test('codes are drawn from more than a handful of values', () => {
  // Guards against a generator that is accidentally constant or near-constant,
  // which would be a silent hole in the only thing gating the room.
  const seen = new Set();
  for (let i = 0; i < 300; i += 1) seen.add(generateRoomCode());
  assert.ok(seen.size > 250, `expected variety, saw ${seen.size} distinct codes`);
});

test('pasting the URL is enough for the first arrival', () => {
  const slot = new RoomSlot();
  assert.equal(slot.occupied, false);
  const first = slot.admit({ name: 'shubh' });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.ok(isRoomCode(first.room.code));
  assert.equal(first.room.hostId, first.peer.id);
});

test('everyone after the first needs the code', () => {
  const slot = new RoomSlot();
  const first = slot.admit({ name: 'a' });
  assert.equal(slot.admit({ name: 'b' }).reason, 'bad-code');
  assert.equal(slot.admit({ code: 'ZZZZ', name: 'b' }).reason, 'bad-code');
  const joined = slot.admit({ code: first.room.code, name: 'b' });
  assert.equal(joined.ok, true);
  assert.equal(joined.created, false);
  assert.equal(joined.room.size, 2);
});

test('the code is matched however it was typed', () => {
  const slot = new RoomSlot();
  const code = slot.admit({ name: 'a' }).room.code;
  assert.equal(slot.admit({ code: code.toLowerCase(), name: 'b' }).ok, true);
  assert.equal(slot.admit({ code: ` ${code} `, name: 'c' }).ok, true);
  assert.equal(slot.admit({ code: code.split('').join('-'), name: 'd' }).ok, true);
});

test('a room fills up and then refuses', () => {
  const slot = new RoomSlot({ maxPeers: 3 });
  const code = slot.admit({ name: 'a' }).room.code;
  assert.equal(slot.admit({ code, name: 'b' }).ok, true);
  assert.equal(slot.admit({ code, name: 'c' }).ok, true);
  assert.equal(slot.admit({ code, name: 'd' }).reason, 'room-full');
});

test('the room survives its host leaving but not its last member', () => {
  const slot = new RoomSlot();
  const first = slot.admit({ name: 'a' });
  const code = first.room.code;
  const second = slot.admit({ code, name: 'b' });

  slot.remove(first.peer.id);
  assert.equal(slot.occupied, true, 'the room outlives its creator');
  assert.equal(slot.room.code, code, 'and keeps the code everyone was told');
  assert.equal(slot.room.hostId, second.peer.id);

  slot.remove(second.peer.id);
  assert.equal(slot.occupied, false);
});

test('the next game gets a different code', () => {
  const slot = new RoomSlot();
  const first = slot.admit({ name: 'a' });
  const oldCode = first.room.code;
  slot.remove(first.peer.id);
  const next = slot.admit({ name: 'b' });
  assert.notEqual(next.room.code, oldCode,
    'reusing the code just discarded would confuse anyone still holding it');
});

test('a code offered to an empty relay is refused rather than silently honoured', () => {
  // Someone typing a code for a game that has ended should be told so, not
  // quietly made host of a different one under a code nobody else knows.
  const slot = new RoomSlot();
  const result = slot.admit({ code: 'ABCD', name: 'late' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-room');
  assert.equal(slot.occupied, false, 'and no room is created as a side effect');
});

test('the health description tracks occupancy', () => {
  const slot = new RoomSlot();
  assert.deepEqual(slot.describe(), { relay: true, room: false, peers: 0 });
  const first = slot.admit({ name: 'a' });
  assert.deepEqual(slot.describe(), { relay: true, room: true, peers: 1 });
  slot.remove(first.peer.id);
  assert.deepEqual(slot.describe(), { relay: true, room: false, peers: 0 });
});

test('a room reports its own occupancy honestly', () => {
  const room = new RelayRoom({ code: 'ABCD', maxPeers: 2 });
  assert.equal(room.empty, true);
  room.join('a');
  assert.equal(room.empty, false);
  assert.equal(room.full, false);
  room.join('b');
  assert.equal(room.full, true);
  assert.equal(room.accepts('abcd'), true);
  assert.equal(room.accepts('ABCE'), false);
});
