// Names floating over heads.
//
// DOM rather than sprites. Text drawn into a canvas texture goes soft the
// moment a body is further away than the texel density assumed, and every
// distinct name would need its own texture; the browser already renders crisp
// text at any size for free. The rest of the HUD -- hitmarker, killfeed, death
// card -- is DOM for the same reason, so this follows the house style.
//
// The expensive part is not drawing, it is deciding who can actually be seen.
// `enemy-system.js` warns in its own comments that full-map collision raycasts
// are costly enough to stagger, and it staggers six of them. This can face
// thirteen, so it checks a couple of bodies per frame and remembers the verdict.
// A plate that lingers a tenth of a second after someone steps behind a
// bulkhead is imperceptible; thirteen raycasts every frame would not be.

import * as THREE from 'three';

const _head = new THREE.Vector3();
const _ndc = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _ray = new THREE.Ray();

/** Height above a body's origin where its name sits, in game units. */
export const HEAD_OFFSET = 78;

const CSS = `
.cod-nameplates {
  position: fixed; inset: 0; pointer-events: none; overflow: hidden;
  z-index: 5; font: 600 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
  letter-spacing: .09em; text-transform: uppercase;
}
.cod-nameplate {
  position: absolute; transform: translate(-50%, -100%);
  white-space: nowrap; color: #dce9f5;
  text-shadow: 0 1px 2px rgba(0, 0, 0, .95), 0 0 6px rgba(0, 0, 0, .8);
  will-change: transform, opacity;
}
/* People and bots are both targets in a free-for-all, so the useful
   distinction is not friend or foe -- it is whether there is a person there. */
.cod-nameplate[data-kind="player"] { color: #7fffc4; }
.cod-nameplate[data-kind="bot"] { color: #cddbe6; opacity: .82; }
`;

/**
 * Fade with distance so a crowded deck does not turn into a wall of text.
 * Full strength up close, linear to nothing at the cull range.
 */
export function opacityForDistance(distance, maxDistance, fadeStart = maxDistance * 0.55) {
  if (!(distance >= 0) || distance >= maxDistance) return 0;
  if (distance <= fadeStart) return 1;
  const span = maxDistance - fadeStart;
  return span > 0 ? Math.max(0, 1 - (distance - fadeStart) / span) : 1;
}

/**
 * Which entries to line-of-sight check on this frame.
 *
 * Round-robin from a moving cursor so every body is revisited at a steady
 * rate no matter how many there are, rather than the first few being checked
 * constantly and the rest never.
 */
export function staggerWindow(cursor, perFrame, total) {
  if (total <= 0 || perFrame <= 0) return [];
  const count = Math.min(perFrame, total);
  const picked = [];
  for (let i = 0; i < count; i += 1) picked.push((cursor + i) % total);
  return picked;
}

export class Nameplates {
  /**
   * @param {object} options
   * @param {HTMLElement} [options.root] where the layer is appended
   * @param {number} [options.maxDistance] cull range in game units
   * @param {number} [options.checksPerFrame] line-of-sight raycasts per frame
   */
  constructor({ root = null, maxDistance = 3000, checksPerFrame = 2, headOffset = HEAD_OFFSET } = {}) {
    this.maxDistance = maxDistance;
    this.checksPerFrame = checksPerFrame;
    this.headOffset = headOffset;
    this.cursor = 0;
    this.plates = new Map();
    // Verdicts persist between checks. Unknown counts as blocked: a plate that
    // appears a frame late costs nothing, while one that flashes through a wall
    // before the first raycast lands is a wallhack, however brief.
    this.blocked = new Map();
    this.layer = null;
    this.visibleCount = 0;

    const doc = typeof document === 'undefined' ? null : document;
    if (!doc?.createElement) return;
    if (!doc.getElementById?.('cod-nameplate-style')) {
      const style = doc.createElement('style');
      style.id = 'cod-nameplate-style';
      style.textContent = CSS;
      doc.head?.appendChild?.(style);
    }
    this.layer = doc.createElement('div');
    this.layer.className = 'cod-nameplates';
    (root ?? doc.body)?.appendChild?.(this.layer);
  }

  /**
   * @param {object} frame
   * @param {THREE.Camera} frame.camera
   * @param {object} frame.collisionWorld exposes raycastFirst(ray, near, far)
   * @param {Array} frame.targets `{ id, name, position, dead, kind }`
   * @param {number} frame.width viewport width in CSS pixels
   * @param {number} frame.height viewport height in CSS pixels
   * @param {boolean} [frame.visible] false hides the whole layer
   */
  update({ camera, collisionWorld = null, targets = [], width, height, visible = true }) {
    if (!this.layer) return 0;
    if (!visible || !camera || !width || !height) {
      this.hideAll();
      return 0;
    }

    this.runVisibilityChecks(camera, collisionWorld, targets);

    const live = new Set();
    let shown = 0;

    for (const target of targets) {
      if (!target?.id || !target.position || target.dead) continue;
      live.add(target.id);

      _head.copy(target.position);
      _head.y += this.headOffset;

      const distance = camera.position.distanceTo(_head);
      const opacity = opacityForDistance(distance, this.maxDistance);
      if (opacity <= 0) { this.hide(target.id); continue; }
      if (this.blocked.get(target.id) !== false) { this.hide(target.id); continue; }

      _ndc.copy(_head).project(camera);
      // z beyond 1 is behind the camera, where the projection mirrors the
      // point to the opposite side of the screen and reads as valid.
      if (_ndc.z > 1 || _ndc.x < -1.2 || _ndc.x > 1.2 || _ndc.y < -1.2 || _ndc.y > 1.2) {
        this.hide(target.id);
        continue;
      }

      const x = (_ndc.x * 0.5 + 0.5) * width;
      const y = (1 - (_ndc.y * 0.5 + 0.5)) * height;
      this.draw(target, x, y, opacity);
      shown += 1;
    }

    for (const [id, plate] of this.plates) {
      if (live.has(id)) continue;
      plate.remove?.();
      this.plates.delete(id);
      this.blocked.delete(id);
    }

    this.visibleCount = shown;
    return shown;
  }

  /** Raycast a slice of the targets against the map and remember the result. */
  runVisibilityChecks(camera, collisionWorld, targets) {
    if (!targets.length) return;
    if (!collisionWorld?.raycastFirst) {
      // No collision data loaded yet. Showing everything would be a wallhack,
      // so nothing is shown until the map can answer.
      for (const target of targets) this.blocked.set(target.id, true);
      return;
    }
    for (const index of staggerWindow(this.cursor, this.checksPerFrame, targets.length)) {
      const target = targets[index];
      if (!target?.id || !target.position) continue;
      _head.copy(target.position);
      _head.y += this.headOffset;
      _eye.copy(camera.position);
      _direction.subVectors(_head, _eye);
      const distance = _direction.length();
      if (distance < 1) { this.blocked.set(target.id, false); continue; }
      _direction.divideScalar(distance);
      _ray.set(_eye, _direction);
      // Stop a little short of the head so the body's own geometry, which is
      // not in the collision mesh anyway, can never count as an obstruction.
      const wall = collisionWorld.raycastFirst(_ray, 2, distance - 8);
      this.blocked.set(target.id, Boolean(wall));
    }
    this.cursor = (this.cursor + this.checksPerFrame) % Math.max(1, targets.length);
  }

  draw(target, x, y, opacity) {
    let plate = this.plates.get(target.id);
    if (!plate) {
      plate = document.createElement('div');
      plate.className = 'cod-nameplate';
      this.layer.appendChild(plate);
      this.plates.set(target.id, plate);
      plate.dataset.lastName = '';
    }
    const name = String(target.name ?? target.id);
    if (plate.dataset.lastName !== name) {
      plate.textContent = name;
      plate.dataset.lastName = name;
    }
    if (plate.dataset.kind !== target.kind) plate.dataset.kind = target.kind ?? 'bot';
    plate.style.transform = `translate(-50%, -100%) translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    plate.style.opacity = opacity.toFixed(2);
    if (plate.hidden) plate.hidden = false;
  }

  hide(id) {
    const plate = this.plates.get(id);
    if (plate && !plate.hidden) plate.hidden = true;
  }

  hideAll() {
    for (const plate of this.plates.values()) plate.hidden = true;
    this.visibleCount = 0;
  }

  /** Compact, serialisable view for the debug API. */
  getState() {
    return {
      plates: this.plates.size,
      visible: this.visibleCount,
      names: [...this.plates.entries()]
        .filter(([, plate]) => !plate.hidden)
        .map(([id, plate]) => ({ id, name: plate.dataset.lastName, kind: plate.dataset.kind })),
    };
  }

  dispose() {
    this.layer?.remove?.();
    this.plates.clear();
    this.blocked.clear();
  }
}

export default Nameplates;
