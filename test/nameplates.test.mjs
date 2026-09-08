import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import * as THREE from 'three';

// A minimal DOM. The projection maths is the part worth testing and it needs a
// real camera, which resolves in Node; the elements only need to record what
// the module did to them.
function installDom() {
  const make = (tag) => {
    const node = {
      tagName: tag,
      children: [],
      style: {},
      dataset: {},
      hidden: false,
      textContent: '',
      className: '',
      id: '',
      appendChild(child) { this.children.push(child); child.parent = this; return child; },
      remove() {
        const list = this.parent?.children;
        if (list) list.splice(list.indexOf(this), 1);
        this.parent = null;
      },
    };
    return node;
  };
  const byId = new Map();
  globalThis.document = {
    head: make('head'),
    body: make('body'),
    createElement: (tag) => make(tag),
    getElementById: (id) => byId.get(id) ?? null,
  };
  const originalAppend = globalThis.document.head.appendChild.bind(globalThis.document.head);
  globalThis.document.head.appendChild = (child) => {
    if (child.id) byId.set(child.id, child);
    return originalAppend(child);
  };
}

let Nameplates; let opacityForDistance; let staggerWindow;

beforeEach(async () => {
  installDom();
  const mod = await import(`../export/web/nameplates.js?t=${Date.now()}`);
  ({ Nameplates, opacityForDistance, staggerWindow } = mod);
});

const camera = () => {
  const c = new THREE.PerspectiveCamera(75, 2, 1, 20000);
  c.position.set(0, 0, 0);
  c.lookAt(0, 0, -1);
  c.updateMatrixWorld(true);
  return c;
};
const clear = { raycastFirst: () => null };
const walled = { raycastFirst: () => ({ distance: 10 }) };
const target = (over = {}) => ({
  id: 'peer-2', name: 'ALEX', position: new THREE.Vector3(0, 0, -500),
  dead: false, kind: 'player', ...over,
});
const plates = (n) => [...n.plates.values()];

test('distance fade is full up close and gone at the cull range', () => {
  assert.equal(opacityForDistance(0, 1000), 1);
  assert.equal(opacityForDistance(400, 1000), 1, 'inside the fade start');
  assert.equal(opacityForDistance(1000, 1000), 0);
  assert.equal(opacityForDistance(5000, 1000), 0);
  const mid = opacityForDistance(775, 1000);
  assert.ok(mid > 0 && mid < 1, `expected a partial fade, got ${mid}`);
  // Junk in must not produce a visible plate.
  assert.equal(opacityForDistance(Number.NaN, 1000), 0);
  assert.equal(opacityForDistance(-5, 1000), 0);
});

test('the stagger visits everyone in turn rather than the same few', () => {
  assert.deepEqual(staggerWindow(0, 2, 5), [0, 1]);
  assert.deepEqual(staggerWindow(4, 2, 5), [4, 0], 'wraps around the end');
  assert.deepEqual(staggerWindow(0, 9, 3), [0, 1, 2], 'never repeats within a frame');
  assert.deepEqual(staggerWindow(0, 2, 0), []);
  assert.deepEqual(staggerWindow(0, 0, 5), []);
});

test('a visible body gets a plate at its projected position', () => {
  const n = new Nameplates({ headOffset: 0 });
  const shown = n.update({
    camera: camera(), collisionWorld: clear, targets: [target()], width: 800, height: 600,
  });
  assert.equal(shown, 1);
  const plate = plates(n)[0];
  assert.equal(plate.textContent, 'ALEX');
  assert.equal(plate.dataset.kind, 'player');
  assert.equal(plate.hidden, false);
  // Dead ahead of the camera lands in the middle of the viewport.
  assert.match(plate.style.transform, /translate\(400px, 300px\)/);
});

test('a body behind the camera is not drawn in front of it', () => {
  // Projection mirrors points behind the camera onto the screen, so without an
  // explicit check someone at your back appears ahead of you.
  const n = new Nameplates({ headOffset: 0 });
  const shown = n.update({
    camera: camera(), collisionWorld: clear,
    targets: [target({ position: new THREE.Vector3(0, 0, 500) })],
    width: 800, height: 600,
  });
  assert.equal(shown, 0);
});

test('a body behind cover has no plate', () => {
  const n = new Nameplates({ headOffset: 0 });
  const shown = n.update({
    camera: camera(), collisionWorld: walled, targets: [target()], width: 800, height: 600,
  });
  assert.equal(shown, 0, 'a plate readable through steel is a wallhack');
});

test('nothing is shown until the map can answer', () => {
  // Defaulting to visible while collision is still loading would flash every
  // position on the map through the walls.
  const n = new Nameplates({ headOffset: 0 });
  assert.equal(n.update({
    camera: camera(), collisionWorld: null, targets: [target()], width: 800, height: 600,
  }), 0);
});

test('the dead lose their plate', () => {
  const n = new Nameplates({ headOffset: 0 });
  assert.equal(n.update({
    camera: camera(), collisionWorld: clear, targets: [target({ dead: true })],
    width: 800, height: 600,
  }), 0);
});

test('a body past the cull range is dropped', () => {
  const n = new Nameplates({ headOffset: 0, maxDistance: 300 });
  assert.equal(n.update({
    camera: camera(), collisionWorld: clear, targets: [target()], width: 800, height: 600,
  }), 0);
});

test('hiding the HUD hides the plates', () => {
  const n = new Nameplates({ headOffset: 0 });
  n.update({ camera: camera(), collisionWorld: clear, targets: [target()], width: 800, height: 600 });
  assert.equal(plates(n)[0].hidden, false);
  n.update({
    camera: camera(), collisionWorld: clear, targets: [target()],
    width: 800, height: 600, visible: false,
  });
  assert.equal(plates(n)[0].hidden, true);
  assert.equal(n.visibleCount, 0);
});

test('a departed body takes its plate with it', () => {
  const n = new Nameplates({ headOffset: 0 });
  const camera_ = camera();
  n.update({ camera: camera_, collisionWorld: clear, targets: [target()], width: 800, height: 600 });
  assert.equal(n.plates.size, 1);
  n.update({ camera: camera_, collisionWorld: clear, targets: [], width: 800, height: 600 });
  assert.equal(n.plates.size, 0, 'the element is removed, not just hidden');
  assert.equal(n.blocked.size, 0, 'and its cached verdict is forgotten');
});

test('a renamed body updates its plate', () => {
  const n = new Nameplates({ headOffset: 0 });
  const camera_ = camera();
  n.update({ camera: camera_, collisionWorld: clear, targets: [target()], width: 800, height: 600 });
  n.update({
    camera: camera_, collisionWorld: clear, targets: [target({ name: 'SHUBH' })],
    width: 800, height: 600,
  });
  assert.equal(plates(n)[0].textContent, 'SHUBH');
  assert.equal(n.plates.size, 1, 'the same element is reused');
});

test('debug state is compact and serialisable', () => {
  const n = new Nameplates({ headOffset: 0 });
  n.update({ camera: camera(), collisionWorld: clear, targets: [target()], width: 800, height: 600 });
  const state = n.getState();
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  assert.equal(state.visible, 1);
  assert.deepEqual(state.names, [{ id: 'peer-2', name: 'ALEX', kind: 'player' }]);
});
