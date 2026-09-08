import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LanRoster, MAX_PEERS } from '../server/lan-roster.mjs';

// A fake clock, because joinedAt is the only wall-clock value in the roster and
// a test that reads Date.now() would be asserting on the machine, not the code.
const fixedClock = (start = 1000) => {
  let value = start;
  const now = () => value;
  now.advance = (ms) => { value += ms; };
  return now;
};

test('peer ids are sequential and never reused within a server lifetime', () => {
  const roster = new LanRoster({ now: fixedClock() });
  assert.equal(roster.join('a').id, 'peer-1');
  assert.equal(roster.join('b').id, 'peer-2');
  assert.equal(roster.join('c').id, 'peer-3');

  // peer-2 leaving must not free its id: a frame still in flight from the old
  // peer-2 would otherwise land on whoever took the number next.
  assert.equal(roster.leave('peer-2'), true);
  assert.equal(roster.join('d').id, 'peer-4');
  assert.deepEqual(roster.peers.map((peer) => peer.id), ['peer-1', 'peer-3', 'peer-4']);
});

test('leave reports whether the peer was there', () => {
  const roster = new LanRoster({ now: fixedClock() });
  roster.join('a');
  assert.equal(roster.leave('peer-1'), true);
  assert.equal(roster.leave('peer-1'), false);
  assert.equal(roster.leave('peer-99'), false);
});

test('joinedAt comes from the injected clock', () => {
  const now = fixedClock(500);
  const roster = new LanRoster({ now });
  const first = roster.join('a');
  now.advance(250);
  const second = roster.join('b');
  assert.equal(first.joinedAt, 500);
  assert.equal(second.joinedAt, 750);
  assert.equal(first.order, 1);
  assert.equal(second.order, 2);
});

test('the host is the oldest surviving peer, and null when empty', () => {
  const roster = new LanRoster({ now: fixedClock() });
  assert.equal(roster.hostId, null);
  roster.join('a');
  roster.join('b');
  assert.equal(roster.hostId, 'peer-1');
  roster.leave('peer-1');
  roster.leave('peer-2');
  assert.equal(roster.hostId, null);
});

test('the host migrates to the next-oldest peer when the host leaves', () => {
  const roster = new LanRoster({ now: fixedClock() });
  roster.join('a');
  roster.join('b');
  roster.join('c');

  const before = roster.hostId;
  roster.leave(before);
  const after = roster.hostId;
  assert.equal(before, 'peer-1');
  assert.equal(after, 'peer-2');
  assert.notEqual(before, after);

  // A peer that joins after the migration is younger than the sitting host and
  // must not steal it back.
  roster.join('d');
  assert.equal(roster.hostId, 'peer-2');
});

test('the host is unchanged when a guest leaves', () => {
  const roster = new LanRoster({ now: fixedClock() });
  roster.join('a');
  roster.join('b');
  roster.join('c');

  const before = roster.hostId;
  roster.leave('peer-3');
  assert.equal(roster.hostId, before);
  roster.leave('peer-2');
  assert.equal(roster.hostId, before);
});

test('roster() serialises in join order with exactly one host flagged', () => {
  const roster = new LanRoster({ now: fixedClock() });
  roster.join('ana');
  roster.join('bo');
  roster.join('cy');
  roster.leave('peer-1');

  assert.deepEqual(roster.roster(), [
    { id: 'peer-2', name: 'BO', host: true },
    { id: 'peer-3', name: 'CY', host: false },
  ]);
  assert.equal(roster.roster().filter((entry) => entry.host).length, 1);
  assert.deepEqual(roster.entry('peer-3'), { id: 'peer-3', name: 'CY', host: false });
  assert.equal(roster.entry('peer-1'), null);
});

test('the roster is capped at eight and a full join returns null', () => {
  const roster = new LanRoster({ now: fixedClock() });
  for (let i = 0; i < MAX_PEERS; i += 1) assert.ok(roster.join(`p${i}`));
  assert.equal(roster.size, MAX_PEERS);
  assert.equal(roster.full, true);
  assert.equal(roster.join('ninth'), null);
  assert.equal(roster.size, MAX_PEERS);

  // A seat opening up admits the next person, still with a fresh id.
  roster.leave('peer-3');
  assert.equal(roster.join('ninth').id, 'peer-9');
});

test('names are sanitised on join and on rename', () => {
  const roster = new LanRoster({ now: fixedClock() });
  assert.equal(roster.join(' bob the builder ').name, 'BOB THE BUILDER');
  assert.equal(roster.join('A very long player name').name, 'A VERY LONG PLAY');
  // Whitespace runs collapse, so a padded name cannot stretch a scoreboard row.
  assert.equal(roster.join('ana\t\n  lee').name, 'ANA LEE');

  // An unnamed peer gets its join order, so an eight-person lobby does not
  // render as eight identical rows before anyone sends hello.
  assert.equal(roster.join('').name, 'PLAYER 4');
  assert.equal(roster.join(null).name, 'PLAYER 5');

  assert.equal(roster.rename('peer-5', 'ghost rider').name, 'GHOST RIDER');
  // An empty hello keeps the name already on the record rather than blanking it.
  assert.equal(roster.rename('peer-5', '   ').name, 'GHOST RIDER');
  assert.equal(roster.rename('peer-99', 'nobody'), null);
});
