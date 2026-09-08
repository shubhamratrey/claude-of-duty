import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SnapshotBuffer, lerpAngle } from '../export/web/net/snapshot-buffer.js';

const body = (overrides = {}) => ({
  pos: [0, 0, 0],
  yaw: 0,
  pitch: 0,
  health: 100,
  alive: true,
  state: 'idle',
  frame: 0,
  flags: 0,
  weaponId: 'ak47',
  ...overrides,
});

/** Compare angles by shortest arc, so pi and -pi count as equal. */
const assertAngle = (actual, expected, message = 'angle') => {
  const delta = Math.abs(Math.atan2(Math.sin(actual - expected), Math.cos(actual - expected)));
  assert.ok(delta < 1e-9, `${message}: ${actual} is not ${expected}`);
};

test('an empty buffer samples to null and reports no bounds', () => {
  const buffer = new SnapshotBuffer();
  assert.equal(buffer.sample(1), null);
  assert.equal(buffer.length, 0);
  assert.equal(buffer.oldestTime, null);
  assert.equal(buffer.newestTime, null);
});

test('samples stay ordered and late or duplicate arrivals are dropped', () => {
  const buffer = new SnapshotBuffer();
  assert.equal(buffer.push(1, body({ frame: 1 })), true);
  assert.equal(buffer.push(2, body({ frame: 2 })), true);
  assert.equal(buffer.push(1.5, body({ frame: 99 })), false, 'reordered frame');
  assert.equal(buffer.push(2, body({ frame: 98 })), false, 'duplicate timestamp');
  assert.equal(buffer.push(Number.NaN, body()), false, 'unusable timestamp');

  assert.equal(buffer.length, 2);
  assert.equal(buffer.oldestTime, 1);
  assert.equal(buffer.newestTime, 2);
  assert.equal(buffer.sample(1.5).frame, 1, 'the rejected frame never entered the buffer');
});

test('the buffer evicts by count and by age but always keeps the newest', () => {
  const byCount = new SnapshotBuffer({ maxSamples: 4, maxAgeSeconds: 60 });
  for (let i = 0; i < 6; i += 1) byCount.push(i, body({ frame: i }));
  assert.equal(byCount.length, 4);
  assert.equal(byCount.oldestTime, 2);
  assert.equal(byCount.newestTime, 5);

  const byAge = new SnapshotBuffer({ maxAgeSeconds: 1 });
  byAge.push(0, body());
  byAge.push(0.5, body());
  byAge.push(1, body());
  assert.equal(byAge.length, 3, 'a sample exactly maxAgeSeconds old is still useful');
  byAge.push(2.5, body({ frame: 7 }));
  assert.equal(byAge.length, 1);
  assert.equal(byAge.sample(2.5).frame, 7);

  byAge.clear();
  assert.equal(byAge.length, 0);
});

test('sampling between two states interpolates position, angles, and health', () => {
  const buffer = new SnapshotBuffer();
  buffer.push(10, body({ pos: [0, 2, -4], yaw: 0, pitch: -0.2, health: 100 }));
  buffer.push(11, body({ pos: [10, 4, 4], yaw: 1, pitch: 0.2, health: 40 }));

  const midpoint = buffer.sample(10.5);
  assert.deepEqual(midpoint.pos, [5, 3, 0]);
  assertAngle(midpoint.yaw, 0.5);
  assertAngle(midpoint.pitch, 0);
  assert.equal(midpoint.health, 70);

  const quarter = buffer.sample(10.25);
  assert.deepEqual(quarter.pos, [2.5, 2.5, -2]);
  assert.equal(quarter.health, 85);
});

test('sampling clamps at both edges instead of extrapolating', () => {
  const buffer = new SnapshotBuffer();
  buffer.push(10, body({ pos: [0, 0, 0], frame: 1 }));
  buffer.push(11, body({ pos: [10, 0, 0], frame: 2 }));

  const before = buffer.sample(5);
  assert.deepEqual(before.pos, [0, 0, 0], 'no backwards extrapolation');
  assert.equal(before.frame, 1);

  const after = buffer.sample(30);
  assert.deepEqual(after.pos, [10, 0, 0], 'the body holds position instead of sliding off');
  assert.equal(after.frame, 2);

  after.pos[0] = 999;
  assert.deepEqual(buffer.sample(30).pos, [10, 0, 0], 'samples are copies, not the stored state');
});

test('discrete fields step from the sample at or before the sampled time', () => {
  const buffer = new SnapshotBuffer();
  buffer.push(0, body({ state: 'run', frame: 4, flags: 5, weaponId: 'ak47', alive: true }));
  buffer.push(1, body({ state: 'death', frame: 12, flags: 0, weaponId: 'm1911', alive: false }));

  for (const time of [0.1, 0.5, 0.99]) {
    const sampled = buffer.sample(time);
    assert.equal(sampled.state, 'run', 'a pose name is never blended');
    assert.equal(sampled.frame, 4, 'a pose frame index is never averaged');
    assert.equal(sampled.flags, 5, 'a bitfield is never averaged');
    assert.equal(sampled.weaponId, 'ak47');
    assert.equal(sampled.alive, true);
  }
  assert.equal(buffer.sample(1).state, 'death');
  assert.equal(buffer.sample(1).alive, false);
});

test('lerpAngle takes the shortest arc across the -pi/+pi seam', () => {
  assertAngle(lerpAngle(0, Math.PI / 2, 0.5), Math.PI / 4);
  assertAngle(lerpAngle(1, 2, 0), 1);
  assertAngle(lerpAngle(1, 2, 1), 2);

  // 3.1 and -3.1 are 0.083 rad apart across the seam, not 6.2 the long way.
  assertAngle(lerpAngle(3.1, -3.1, 0.5), Math.PI);
  assertAngle(lerpAngle(-3.1, 3.1, 0.5), Math.PI);
  assertAngle(lerpAngle(3.1, -3.1, 1), -3.1);

  const eighth = lerpAngle(Math.PI - 0.2, -Math.PI + 0.2, 0.5);
  assertAngle(eighth, Math.PI);
  assert.ok(Math.abs(eighth) <= Math.PI + 1e-9, 'the result stays in range');
});

test('a body crossing the seam interpolates without spinning the long way', () => {
  const buffer = new SnapshotBuffer();
  buffer.push(0, body({ yaw: 3.1 }));
  buffer.push(1, body({ yaw: -3.1 }));

  let previous = buffer.sample(0).yaw;
  let travelled = 0;
  for (let step = 1; step <= 10; step += 1) {
    const yaw = buffer.sample(step / 10).yaw;
    travelled += Math.abs(Math.atan2(Math.sin(yaw - previous), Math.cos(yaw - previous)));
    previous = yaw;
  }
  assert.ok(travelled < 0.2, `swept ${travelled} rad, expected the short way round`);
});
