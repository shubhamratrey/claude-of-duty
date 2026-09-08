// Wire protocol for LAN multiplayer.
//
// JSON over WebSocket. At 20 Hz across eight players this is roughly 32 KB/s,
// which is nothing on a LAN and stays readable in devtools while debugging.
// Binary packing is a later optimisation, not a launch requirement.
//
// Every frame is an envelope: { v, t, d, from }. The server stamps `from` on
// relayed frames so a client can never claim to be another peer. Frames that
// fail validation are dropped rather than thrown, because one malformed
// message from one peer must not tear down a match for everyone.

export const PROTOCOL_VERSION = 1;

/** Server-authored message types. Clients may only receive these. */
export const SERVER_MESSAGES = Object.freeze({
  WELCOME: 'welcome',
  PEER_JOINED: 'peerJoined',
  PEER_LEFT: 'peerLeft',
  HOST_CHANGED: 'hostChanged',
  PONG: 'pong',
  ERROR: 'error',
  // A relay holds one room at a time. This says somebody is already in it, so
  // the code is needed; the LAN server never sends it.
  ROOM_REQUIRED: 'roomRequired',
});

/** Client-authored message types. The server relays these unread. */
export const CLIENT_MESSAGES = Object.freeze({
  HELLO: 'hello',
  PING: 'ping',
  JOIN_ROOM: 'joinRoom',
  PLAYER_STATE: 'playerState',
  BOT_STATE: 'botState',
  MATCH_STATE: 'matchState',
  SPAWN: 'spawn',
  WEAPON_FIRE: 'weaponFire',
  HIT: 'hit',
  DIED: 'died',
});

export const MSG = Object.freeze({ ...SERVER_MESSAGES, ...CLIENT_MESSAGES });

/** Messages only the elected host may author. Guests sending these are ignored. */
export const HOST_ONLY = Object.freeze(new Set([
  MSG.BOT_STATE, MSG.MATCH_STATE, MSG.SPAWN,
]));

/** Movement state packed into one integer on `playerState`. */
export const FLAG = Object.freeze({
  CROUCHED: 1 << 0,
  SPRINTING: 1 << 1,
  MOVING: 1 << 2,
  FIRING: 1 << 3,
  AIMING: 1 << 4,
  GROUNDED: 1 << 5,
});

/** Pose states a networked body can be in. Mirrors EnemyManager.poseTemplates. */
export const POSE = Object.freeze(['idle', 'run', 'death']);

/** Hitbox names carried on `hit`, mirroring Enemy.hitboxes. */
export const HITBOX = Object.freeze(['torso', 'head', 'legs']);

/**
 * Room-code alphabet: 32 symbols with I, O, 0 and 1 removed.
 *
 * Codes get read out over voice chat, and those four are the pairs people
 * mishear and mistype. Four characters gives 1,048,576 combinations, which is
 * ample when a relay holds one room at a time.
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;

const ROOM_CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

/** Fold typed input toward the alphabet: trim, uppercase, drop separators. */
export const normalizeRoomCode = (value) => String(value ?? '')
  .toUpperCase()
  .replace(new RegExp(`[^${ROOM_CODE_ALPHABET}]`, 'g'), '')
  .slice(0, ROOM_CODE_LENGTH);

export const isRoomCode = (value) => typeof value === 'string' && ROOM_CODE_PATTERN.test(value);

/** Reasons a relay refuses admission. */
export const JOIN_ERRORS = Object.freeze(['bad-code', 'room-full', 'no-room', 'relay-full']);

// Sanity bounds. These catch honest bugs and desyncs, not adversaries: on a
// LAN among friends the threat model is a stale build, not a cheater.
export const LIMITS = Object.freeze({
  MAX_DAMAGE: 200,
  MAX_COORDINATE: 100000,
  MAX_NAME_LENGTH: 16,
  MAX_BOTS: 32,
  MAX_FRAME_BYTES: 65536,
});

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const isCoordinate = (value) => isFiniteNumber(value) &&
  Math.abs(value) <= LIMITS.MAX_COORDINATE;

const isVec3 = (value) => Array.isArray(value) && value.length === 3 &&
  value.every(isCoordinate);

const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 64;

const isAngle = (value) => isFiniteNumber(value) && Math.abs(value) <= Math.PI * 4;

/** Positions are rounded to a hundredth of a unit; the map is thousands wide. */
export const roundCoordinate = (value) => Math.round(value * 100) / 100;

/** Angles keep four decimals, well under a rendered pixel of yaw at any range. */
export const roundAngle = (value) => Math.round(value * 10000) / 10000;

export const packVec3 = (vector) => [
  roundCoordinate(vector.x), roundCoordinate(vector.y), roundCoordinate(vector.z),
];

export const packFlags = ({ crouched, sprinting, moving, firing, aiming, grounded } = {}) =>
  (crouched ? FLAG.CROUCHED : 0) |
  (sprinting ? FLAG.SPRINTING : 0) |
  (moving ? FLAG.MOVING : 0) |
  (firing ? FLAG.FIRING : 0) |
  (aiming ? FLAG.AIMING : 0) |
  (grounded ? FLAG.GROUNDED : 0);

export const unpackFlags = (flags) => ({
  crouched: Boolean(flags & FLAG.CROUCHED),
  sprinting: Boolean(flags & FLAG.SPRINTING),
  moving: Boolean(flags & FLAG.MOVING),
  firing: Boolean(flags & FLAG.FIRING),
  aiming: Boolean(flags & FLAG.AIMING),
  grounded: Boolean(flags & FLAG.GROUNDED),
});

/**
 * A display name is trusted for length and shape, never for uniqueness.
 * Control characters are stripped and whitespace runs collapsed, so a name
 * can neither break the scoreboard layout nor smuggle terminal escapes into
 * the server's console output.
 */
export const sanitizeName = (value, fallback = 'PLAYER') => {
  const text = String(value ?? '')
    // Control characters become a space rather than vanishing, so a pasted
    // two-line name reads as two words instead of onejammedtogether.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (text.slice(0, LIMITS.MAX_NAME_LENGTH).trim() || fallback).toUpperCase();
};

// Per-type validators. Each returns true only when every field the readers
// depend on is present and in range, so consumers never defend themselves.
const VALIDATORS = {
  // roomCode is present only from a relay; the LAN server omits it entirely,
  // so its absence must stay valid or the LAN path breaks.
  [MSG.WELCOME]: (d) => isId(d.peerId) && (d.hostId === null || isId(d.hostId)) &&
    Array.isArray(d.roster) && isFiniteNumber(d.serverTime) &&
    (d.roomCode === undefined || d.roomCode === null || isRoomCode(d.roomCode)),
  [MSG.PEER_JOINED]: (d) => Boolean(d.peer) && isId(d.peer.id),
  [MSG.PEER_LEFT]: (d) => isId(d.peerId),
  [MSG.HOST_CHANGED]: (d) => d.hostId === null || isId(d.hostId),
  [MSG.PONG]: (d) => isFiniteNumber(d.clientTime) && isFiniteNumber(d.serverTime),
  [MSG.ERROR]: (d) => typeof d.message === 'string' &&
    (d.reason === undefined || typeof d.reason === 'string'),
  [MSG.ROOM_REQUIRED]: () => true,

  [MSG.HELLO]: (d) => typeof d.name === 'string',
  [MSG.PING]: (d) => isFiniteNumber(d.clientTime),
  [MSG.JOIN_ROOM]: (d) => isRoomCode(d.code) && typeof d.name === 'string',

  [MSG.PLAYER_STATE]: (d) => Number.isInteger(d.seq) && isFiniteNumber(d.t) &&
    isVec3(d.pos) && isAngle(d.yaw) && isAngle(d.pitch) &&
    Number.isInteger(d.flags) && isFiniteNumber(d.health) && typeof d.alive === 'boolean',

  [MSG.BOT_STATE]: (d) => isFiniteNumber(d.t) && Array.isArray(d.bots) &&
    d.bots.length <= LIMITS.MAX_BOTS && d.bots.every((bot) =>
      Number.isInteger(bot.i) && isVec3(bot.pos) && isAngle(bot.yaw) &&
      POSE.includes(bot.state) && Number.isInteger(bot.frame) &&
      typeof bot.dead === 'boolean'),

  [MSG.MATCH_STATE]: (d) => typeof d.phase === 'string' && Array.isArray(d.standings),
  [MSG.SPAWN]: (d) => isId(d.peerId) && isVec3(d.pos) && isAngle(d.yaw),

  [MSG.WEAPON_FIRE]: (d) => isVec3(d.origin) && isVec3(d.dir),

  [MSG.HIT]: (d) => isId(d.target) && isFiniteNumber(d.damage) &&
    d.damage > 0 && d.damage <= LIMITS.MAX_DAMAGE && HITBOX.includes(d.box),

  [MSG.DIED]: (d) => (d.by === null || isId(d.by)) && isFiniteNumber(d.at),
};

/** True when `type` is a known message whose payload passes its validator. */
export function validate(type, data) {
  const validator = VALIDATORS[type];
  if (!validator || data === null || typeof data !== 'object') return false;
  try {
    return validator(data) === true;
  } catch {
    return false;
  }
}

/** Serialise one frame. Throws on an unknown type, which is a programming error. */
export function encode(type, data = {}, from = null) {
  if (!VALIDATORS[type]) throw new Error(`unknown message type: ${type}`);
  const frame = { v: PROTOCOL_VERSION, t: type, d: data };
  if (from !== null) frame.from = from;
  return JSON.stringify(frame);
}

/**
 * Parse one frame from the wire.
 *
 * Returns `{ type, data, from }`, or null for anything malformed, oversized,
 * of the wrong protocol version, or failing its validator. A null return is a
 * normal outcome and callers drop the frame; it never throws, because a peer
 * running a stale build should not be able to end anyone else's match.
 */
export function decode(raw) {
  if (typeof raw !== 'string' || raw.length > LIMITS.MAX_FRAME_BYTES) return null;
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null;
  if (frame.v !== PROTOCOL_VERSION) return null;
  if (typeof frame.t !== 'string' || !validate(frame.t, frame.d)) return null;
  const from = typeof frame.from === 'string' ? frame.from : null;
  return { type: frame.t, data: frame.d, from };
}

/** Combatant id for a peer, used as the FreeForAllMatch key across all clients. */
export const peerCombatantId = (peerId) => String(peerId);

/** Combatant id for a bot. Bots are host-owned, so the index is global. */
export const botCombatantId = (index) => `bot-${index}`;

/** True when a combatant id refers to a bot rather than a person. */
export const isBotId = (id) => typeof id === 'string' && id.startsWith('bot-');

export default {
  PROTOCOL_VERSION, MSG, SERVER_MESSAGES, CLIENT_MESSAGES, HOST_ONLY,
  FLAG, POSE, HITBOX, LIMITS,
  encode, decode, validate,
  ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, normalizeRoomCode, isRoomCode, JOIN_ERRORS,
  packVec3, packFlags, unpackFlags, roundCoordinate, roundAngle, sanitizeName,
  peerCombatantId, botCombatantId, isBotId,
};
