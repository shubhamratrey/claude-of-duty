import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { EnemyManager } from '../export/web/enemy-system.js';

// A real EnemyManager needs a scene, a recast crowd, a collision BVH and the
// GLB rigs, none of which exist in Node. Everything below therefore drives the
// real methods against a hand-built manager: `Object.create(prototype)` plus
// the handful of fields each method actually reads. The pose templates are
// bare Groups, which is enough because the rig assembly only clones them and
// looks for weapon tags it will not find.
//
// Covered only by the browser test (`npm run ai:enemy`, and the LAN page test
// in the design): that real baked poses attach a weapon, that a guest's bots
// hold position while `navigation.update()` is skipped, and that a local
// bullet visibly hits a remote player's head through the raycast path.

const poseTemplates = () => ({
  idle: [new THREE.Group()],
  run: [new THREE.Group(), new THREE.Group(), new THREE.Group()],
  death: [new THREE.Group(), new THREE.Group()],
});

function makeManager() {
  const manager = Object.create(EnemyManager.prototype);
  manager.scene = new THREE.Group();
  manager.enemies = [];
  manager.externalActors = new Set();
  manager.player = { position: new THREE.Vector3(10, 60, 20), feetPosition: new THREE.Vector3(10, 0, 20) };
  manager.playerHealth = { dead: false };
  manager.enemyHealth = 100;
  manager.visionRange = 1700;
  manager.visionCosine = -1;
  manager.bakedWeaponMeshCount = 0;
  manager.poseTemplates = poseTemplates();
  manager.weaponTemplate = new THREE.Group();
  manager.weaponMounts = { idle: null, run: null, death: null };
  manager.poseFrameRates = { idle: 1, run: 10, death: 5 };
  manager.clips = { run: { duration: 1 } };
  return manager;
}

const botStub = (index, position = new THREE.Vector3()) => ({
  index,
  dead: false,
  root: { position },
});

test('the module loads in Node and exports the manager', () => {
  assert.equal(typeof EnemyManager, 'function');
});

test('targetId keeps player and bot identities and gives actors their peer id', () => {
  const manager = makeManager();
  const actor = manager.createNetworkActor('peer-3');
  assert.equal(manager.targetId(null), null);
  assert.equal(manager.targetId(manager.player), 'player');
  assert.equal(manager.targetId(botStub(4)), 'bot-4');
  assert.equal(manager.targetId(actor), 'peer-3');
});

test('targetDead reads the health owner for each kind of target', () => {
  const manager = makeManager();
  const actor = manager.createNetworkActor('peer-1');
  const bot = botStub(0);
  assert.equal(manager.targetDead(null), true);
  assert.equal(manager.targetDead(manager.player), false);
  manager.playerHealth.dead = true;
  assert.equal(manager.targetDead(manager.player), true);
  assert.equal(manager.targetDead(bot), false);
  bot.dead = true;
  assert.equal(manager.targetDead(bot), true);
  assert.equal(manager.targetDead(actor), false);
  actor.applyNetworkState({ dead: true });
  assert.equal(manager.targetDead(actor), true);
});

test('targetPosition aims at an external actor chest and targetFeet at its feet', () => {
  const manager = makeManager();
  const actor = manager.createNetworkActor('peer-2');
  actor.applyNetworkState({ pos: [100, 8, -40] });
  assert.deepEqual(manager.targetPosition(actor).toArray(), [100, 50, -40]);
  assert.deepEqual(manager.targetFeet(actor).toArray(), [100, 8, -40]);
});

test('selectTarget considers external actors alongside the player and bots', () => {
  const manager = makeManager();
  // Line of sight is the collision world's job and is stubbed out; what this
  // asserts is that the actor is in the candidate list at all.
  manager.canSeeTarget = () => true;
  const shooter = botStub(0, new THREE.Vector3(0, 0, 0));
  manager.enemies = [shooter];
  assert.equal(manager.selectTarget(shooter), manager.player);
  const actor = manager.createNetworkActor('peer-9');
  actor.applyNetworkState({ pos: [4, 0, 0] });
  assert.equal(manager.selectTarget(shooter), actor, 'the nearer remote player wins');
  actor.applyNetworkState({ dead: true });
  assert.equal(manager.selectTarget(shooter), manager.player, 'a dead actor is not a target');
});

test('hitTargets exposes live external actor hitboxes to local bullets', () => {
  const manager = makeManager();
  assert.deepEqual(manager.hitTargets, []);
  const actor = manager.createNetworkActor('peer-5');
  assert.equal(manager.hitTargets.length, 3);
  assert.deepEqual(
    manager.hitTargets.map((box) => box.userData.enemyHit.region),
    ['torso', 'head', 'legs'],
  );
  assert.equal(manager.hitTargets[1].userData.enemyHit.multiplier, 2);
  actor.applyNetworkState({ dead: true });
  assert.deepEqual(manager.hitTargets, [], 'a dead actor cannot be shot again');
});

test('handlePlayerHit still reports a bot hit the way single-player reads it', () => {
  const manager = makeManager();
  let applied = null;
  const bot = { index: 2, dead: false, takeDamage: (amount) => { applied = amount; return amount; } };
  const head = { userData: { enemyHit: { enemy: bot, multiplier: 2, region: 'head' } } };
  const report = manager.handlePlayerHit({ object: head }, 34);
  assert.equal(applied, 68);
  assert.equal(report.enemy, bot);
  assert.equal(report.region, 'head');
  assert.equal(report.multiplier, 2);
  assert.equal(report.damage, 68);
  assert.equal(report.killed, false);
  assert.equal(report.id, 'bot-2');
  assert.equal(report.kind, 'bot');
  assert.equal(manager.handlePlayerHit({ object: { userData: {} } }, 34), null);
  bot.dead = true;
  assert.equal(manager.handlePlayerHit({ object: head }, 34), null);
});

test('handlePlayerHit reports an external actor without applying damage when asked', () => {
  const manager = makeManager();
  const actor = manager.createNetworkActor('peer-7');
  const torso = actor.hitboxes[0];
  const report = manager.handlePlayerHit({ object: torso }, 40, { apply: false });
  assert.equal(report.kind, 'actor');
  assert.equal(report.id, 'peer-7');
  assert.equal(report.region, 'torso');
  assert.equal(report.damage, 40);
  assert.equal(report.killed, false);
  assert.equal(actor.health, 100, 'apply: false must leave the victim untouched');

  const applies = manager.handlePlayerHit({ object: actor.hitboxes[1] }, 40);
  assert.equal(applies.damage, 80);
  assert.equal(actor.health, 20);
});

test('a network actor tracks health for prediction but never dies locally', () => {
  const manager = makeManager();
  const actor = manager.createNetworkActor('peer-8');
  assert.equal(actor.takeDamage(60), 60);
  assert.equal(actor.takeDamage(9000), 40, 'damage is clamped to remaining health');
  assert.equal(actor.health, 0);
  assert.equal(actor.dead, false, 'death is confirmed by the machine that owns the body');
  actor.applyNetworkState({ dead: true });
  assert.equal(actor.dead, true);
  assert.equal(actor.takeDamage(10), 0);
});

test('applyNetworkState places, turns and poses a replicated body', () => {
  const manager = makeManager();
  const actor = manager.createNetworkActor('peer-4');
  assert.equal(actor.applyNetworkState({ pos: [12, 3, -5], yaw: 1.25, state: 'run', frame: 2 }), true);
  assert.deepEqual(actor.root.position.toArray(), [12, 3, -5]);
  assert.equal(actor.root.rotation.y, 1.25);
  assert.equal(actor.visualState, 'run');
  assert.equal(actor.visualFrameIndex, 2);
  // The local animation resumes from the frame the wire named instead of
  // restarting, so the pose keeps moving until the next snapshot.
  assert.equal(actor.visualTime, 2 / manager.poseFrameRates.run);

  actor.applyNetworkState({ pos: [12, 3, -5], yaw: 1.25, state: 'run', frame: 99 });
  assert.equal(actor.visualFrameIndex, 2, 'an out of range frame clamps to the last one');
  actor.applyNetworkState({ state: 'nonsense', frame: 0 });
  assert.equal(actor.visualState, 'run', 'an unknown pose name is ignored');
});

test('applyNetworkState is a no-op before the pose templates are baked', () => {
  const manager = makeManager();
  const actor = manager.createNetworkActor('peer-6');
  const unbuilt = Object.create(Object.getPrototypeOf(actor));
  assert.equal(unbuilt.applyNetworkState({ pos: [1, 2, 3], dead: true }), false);
});

test('a replicated respawn undoes every part of the death blend', () => {
  const manager = makeManager();
  const actor = manager.createNetworkActor('peer-10');
  actor.takeDamage(100);

  actor.applyNetworkState({ pos: [0, 0, 0], dead: true, state: 'death', frame: 1 });
  assert.equal(actor.dead, true);
  assert.equal(actor.visualState, 'death');
  // update() clamps a frame to 100 ms exactly as Enemy.update() does.
  for (let i = 0; i < 5; i += 1) actor.update(0.1);
  assert.equal(actor.deathBlend, 1);
  assert.ok(actor.modelRoot.rotation.z < -1, 'a dead body tips over');
  assert.ok(actor.modelRoot.position.y < -1, 'and sinks into the deck');

  actor.applyNetworkState({ pos: [200, 0, 200], dead: false, state: 'idle', frame: 0 });
  assert.equal(actor.dead, false);
  assert.equal(actor.deathBlend, 0, 'a respawned body must not keep its death blend');
  assert.equal(actor.modelRoot.rotation.z, 0, 'nor stay lying down');
  assert.equal(actor.modelRoot.position.y, 0, 'nor stay sunk into the deck');
  assert.equal(actor.health, actor.maxHealth);
  assert.equal(actor.visualState, 'idle');
});

test('a snapshot timestamp gives a replica the speed a bot aims at', () => {
  const manager = makeManager();
  const actor = manager.createNetworkActor('peer-11');
  actor.applyNetworkState({ pos: [0, 0, 0], t: 10 });
  assert.equal(actor.movementSpeed, 0, 'the first snapshot has nothing to compare against');
  actor.applyNetworkState({ pos: [0, 0, 20], t: 10.1 });
  assert.equal(Math.round(actor.movementSpeed), 200);
  actor.applyNetworkState({ pos: [0, 0, 40] });
  assert.equal(Math.round(actor.movementSpeed), 200, 'an untimed snapshot keeps the last estimate');
});

test('createNetworkActor needs the baked rig and is idempotent per peer', () => {
  const manager = makeManager();
  manager.poseTemplates = null;
  assert.equal(manager.createNetworkActor('peer-1'), null, 'no rig before load() resolves');
  assert.equal(manager.externalActors.size, 0);

  manager.poseTemplates = poseTemplates();
  const actor = manager.createNetworkActor('peer-1');
  assert.ok(actor);
  assert.equal(manager.createNetworkActor('peer-1'), actor, 'one body per peer id');
  assert.equal(manager.externalActors.size, 1);
  assert.equal(manager.findNetworkActor('peer-1'), actor);
  assert.equal(manager.findNetworkActor('peer-2'), null);
  assert.equal(actor.root.parent, manager.scene);
  assert.equal(actor.hitboxes.length, 3);
  assert.equal(actor.agent, undefined, 'a remote player has no crowd agent');
  assert.equal(typeof actor.decide, 'undefined', 'and no brain');
});

test('destroyNetworkActor detaches the body and drops it from the roster', () => {
  const manager = makeManager();
  const actor = manager.createNetworkActor('peer-12');
  assert.equal(manager.destroyNetworkActor('peer-12'), true);
  assert.equal(manager.externalActors.size, 0);
  assert.equal(actor.root.parent, null);
  assert.equal(manager.destroyNetworkActor('peer-12'), false);
  assert.equal(manager.destroyNetworkActor(manager.createNetworkActor('peer-13')), true);
});

test('losing a peer releases the bots that were hunting it', () => {
  const manager = makeManager();
  const actor = manager.createNetworkActor('peer-14');
  const hunter = { ...botStub(0), currentTarget: actor, playerVisible: true, decisionTimer: 0.3 };
  const other = { ...botStub(1), currentTarget: manager.player, playerVisible: true, decisionTimer: 0.3 };
  manager.enemies = [hunter, other];
  manager.unregisterExternalActor(actor);
  assert.equal(hunter.currentTarget, null);
  assert.equal(hunter.playerVisible, false);
  assert.equal(hunter.decisionTimer, 0);
  assert.equal(other.currentTarget, manager.player, 'other bots keep their target');
});

test('update passes the simulate flag down and still ticks replicated actors', () => {
  const manager = makeManager();
  const calls = [];
  manager.enemies = [{ update: (...args) => calls.push(['bot', ...args]) }];
  manager.externalActors.add({ root: {}, update: (...args) => calls.push(['actor', ...args]) });

  manager.update(0.016);
  manager.update(0.016, { active: false, simulate: false });
  assert.deepEqual(calls, [
    ['bot', 0.016, true, true],
    ['actor', 0.016, true],
    ['bot', 0.016, false, false],
    ['actor', 0.016, false],
  ]);
});

test('networkSnapshot matches the botState payload and rounds like the wire', () => {
  const manager = makeManager();
  manager.enemies = [
    {
      index: 0,
      dead: false,
      visualState: 'run',
      visualFrameIndex: 4,
      root: { position: new THREE.Vector3(1.23456, -2.5, 300.987), rotation: { y: 0.123456789 } },
    },
    {
      index: 1,
      dead: true,
      visualState: null,
      visualFrameIndex: -1,
      // Yaw accumulates past a full turn on a bot that keeps turning one way.
      root: { position: new THREE.Vector3(0, 0, 0), rotation: { y: Math.PI * 5 } },
    },
  ];
  const snapshot = manager.networkSnapshot();
  assert.deepEqual(snapshot[0], {
    i: 0,
    pos: [1.23, -2.5, 300.99],
    yaw: 0.1235,
    state: 'run',
    frame: 4,
    dead: false,
  });
  assert.deepEqual(Object.keys(snapshot[1]).sort(), ['dead', 'frame', 'i', 'pos', 'state', 'yaw']);
  assert.equal(snapshot[1].state, 'idle', 'an unposed body still names a valid pose');
  assert.equal(snapshot[1].frame, 0);
  assert.equal(snapshot[1].dead, true);
  // Five half-turns fold back onto one, well inside the protocol's 4*PI bound
  // that an accumulating yaw would eventually leave.
  assert.ok(Math.abs(snapshot[1].yaw) <= Math.PI + 1e-4, 'yaw is folded back to one turn');
});
