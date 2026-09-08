// Timestamped buffer for remote bodies — other players, and on guests the
// host's bots — sampled interpolated in the past.
//
// The rendering convention is `hostNow - 100 ms`: sampling that far behind
// keeps a sample on either side of the render time, so a body is always
// interpolated between two known states and never predicted. That delay is
// deliberately NOT applied here. The caller passes an already-delayed time,
// which keeps this module a pure function of its samples and testable with no
// clock, no socket, and no Three.js.
//
// Times are host-clock SECONDS, matching `NetClient.hostTimeSeconds()`.
// Vectors are plain numeric arrays, never THREE.Vector3, so this runs in Node;
// the caller converts when it writes the result onto a scene object.

const TAU = Math.PI * 2;

/** Fields blended between two samples. Everything else steps — see `blend`. */
const VECTOR_FIELDS = new Set(['pos']);
const ANGLE_FIELDS = new Set(['yaw', 'pitch']);
const SCALAR_FIELDS = new Set(['health']);

export const lerp = (a, b, t) => a + (b - a) * t;

/** Fold an angle into (-pi, pi] so a sampled yaw never grows without bound. */
const normalizeAngle = (angle) => {
  let value = angle;
  while (value > Math.PI) value -= TAU;
  while (value <= -Math.PI) value += TAU;
  return value;
};

/**
 * Interpolate along the shortest arc. Plain lerp on 3.1 -> -3.1 spins a body
 * most of the way round the compass; the two angles are 0.08 rad apart.
 */
export function lerpAngle(a, b, t) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a;
  let delta = (b - a) % TAU;
  if (delta > Math.PI) delta -= TAU;
  else if (delta < -Math.PI) delta += TAU;
  return normalizeAngle(a + delta * t);
}

const cloneState = (state) => {
  if (!state || typeof state !== 'object') return state;
  const out = {};
  for (const [key, value] of Object.entries(state)) {
    out[key] = Array.isArray(value) ? value.slice() : value;
  }
  return out;
};

/**
 * Blend two states. Only the numeric fields listed above are interpolated;
 * everything else — booleans, pose names, frame indices, weapon ids, flag
 * bitfields — steps from `from`, the sample at or before the sampled time.
 * Averaging a pose frame index or a bitfield produces a state that never
 * existed on the wire, which is worse than being one frame stale.
 */
const blend = (from, to, t) => {
  const out = cloneState(from);
  if (!from || !to || typeof from !== 'object' || typeof to !== 'object') return out;
  for (const key of Object.keys(out)) {
    const left = from[key];
    const right = to[key];
    if (right === undefined) continue;
    if (VECTOR_FIELDS.has(key) && Array.isArray(left) && Array.isArray(right)) {
      out[key] = left.map((value, index) => (
        typeof value === 'number' && typeof right[index] === 'number'
          ? lerp(value, right[index], t)
          : value
      ));
    } else if (ANGLE_FIELDS.has(key) && typeof left === 'number' && typeof right === 'number') {
      out[key] = lerpAngle(left, right, t);
    } else if (SCALAR_FIELDS.has(key) && typeof left === 'number' && typeof right === 'number') {
      out[key] = lerp(left, right, t);
    }
  }
  return out;
};

export class SnapshotBuffer {
  constructor({ maxSamples = 32, maxAgeSeconds = 2 } = {}) {
    this.maxSamples = Math.max(2, Math.trunc(Number(maxSamples) || 32));
    this.maxAgeSeconds = Math.max(0, Number(maxAgeSeconds) || 2);
    this.samples = [];
  }

  get length() {
    return this.samples.length;
  }

  get oldestTime() {
    return this.samples.length ? this.samples[0].time : null;
  }

  get newestTime() {
    return this.samples.length ? this.samples[this.samples.length - 1].time : null;
  }

  clear() {
    this.samples.length = 0;
  }

  /**
   * Append a sample. Returns false when the frame is dropped.
   *
   * Reordered and duplicated arrivals are normal on any network. Inserting one
   * behind the newest sample would rewind whatever the body is being sampled
   * at, which reads as rubber-banding, so a late frame is simply discarded —
   * a fresher one is at most 50 ms away at 20 Hz.
   */
  push(time, state) {
    const stamp = Number(time);
    if (!Number.isFinite(stamp)) return false;
    const newest = this.samples[this.samples.length - 1];
    if (newest && stamp <= newest.time) return false;
    this.samples.push({ time: stamp, state });
    this.evict();
    return true;
  }

  /** Trim by count and by age, always keeping the newest sample. */
  evict() {
    while (this.samples.length > this.maxSamples) this.samples.shift();
    const cutoff = this.samples[this.samples.length - 1].time - this.maxAgeSeconds;
    while (this.samples.length > 1 && this.samples[0].time < cutoff) this.samples.shift();
  }

  /**
   * Interpolated state at `time`, or null when nothing has arrived yet.
   *
   * Both edges clamp rather than extrapolate. Past the newest sample the body
   * holds its last known position instead of sliding off through a wall,
   * which is the behaviour a stalled connection should have; before the oldest
   * it holds the first state it was ever seen in.
   */
  sample(time) {
    const count = this.samples.length;
    if (count === 0) return null;
    const stamp = Number(time);
    const first = this.samples[0];
    const last = this.samples[count - 1];
    if (!Number.isFinite(stamp) || stamp <= first.time) return cloneState(first.state);
    if (stamp >= last.time) return cloneState(last.state);

    let index = count - 1;
    while (index > 0 && this.samples[index].time > stamp) index -= 1;
    const from = this.samples[index];
    const to = this.samples[index + 1] ?? from;
    const span = to.time - from.time;
    return blend(from.state, to.state, span > 0 ? (stamp - from.time) / span : 0);
  }
}

export default SnapshotBuffer;
