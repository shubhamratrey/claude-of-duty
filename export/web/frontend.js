/**
 * Frontend shell: the loading screen, title screen, pause menu, and class
 * picker.
 *
 * The art comes from `zone/all/ui_mp.ff` via `.tools/export_ui.py`, layered in
 * the order the original `menu,main` linked it (backdrop, scrolling fog, glow,
 * logo plate). The layout is not the game's -- T6 menudefs do not dump -- so
 * the screens here are rebuilt around what this viewer actually has.
 *
 * The state machine is deliberately free of DOM access so it can be tested in
 * node; `elements` is optional and every write goes through `render()`.
 */

import {
  sanitizeName, LIMITS, ROOM_CODE_LENGTH, normalizeRoomCode,
} from './net/protocol.js';

// Loader labels are internal asset names; the caption shows something a
// player can read. Unmapped labels fall through unchanged.
const CAPTIONS = {
  map: 'map geometry',
  textures: 'map textures',
  render: 'map scene',
  collision: 'collision',
  navigation: 'navigation mesh',
  shaders: 'compiling shaders',
  hands: 'viewhands',
  weapon: 'weapon',
  magazine: 'magazine',
  enemy: 'enemy body',
  'enemy weapon': 'enemy weapon',
};

export const SCREENS = ['welcome', 'loading', 'title', 'pause', 'class', 'error'];

/**
 * LAN lobby.
 *
 * The panel is pure presentation: it never opens a socket and never imports
 * one. The game drives it through `setLanState()` and reads `getLanName()`,
 * so a shell with no network at all still renders, still says "offline", and
 * still lets the title screen start a single-player match. That separation is
 * what keeps a missing server from being able to block the game.
 */
export const LAN_STATUSES = ['offline', 'connecting', 'connected', 'error'];

// Same `hijacked.` prefix as `hijacked.graphics` and `hijacked.touchSensitivity`.
export const LAN_NAME_KEY = 'hijacked.lanName';
export const RELAY_URL_KEY = 'hijacked.relayUrl';

/** LAN is the zero-config same-WiFi path; relay is a pasted address. */
export const NET_MODES = ['lan', 'relay'];

// Touching the property throws outright in a sandboxed frame, so the access is
// guarded as well as the calls -- index.html does the same for PlayCounter.
const defaultStorage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

const lanPeers = (peers) => {
  const rows = [];
  const seen = new Set();
  for (const peer of Array.isArray(peers) ? peers : []) {
    const source = typeof peer === 'string' ? { id: peer } : peer ?? {};
    const id = String(source.id ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, name: sanitizeName(source.name, id) });
  }
  return rows;
};

const LAN_CSS = `
.fe-lan-modes { display: flex; gap: 6px; }
.fe-lan-mode {
  flex: 1; padding: 5px 8px; font: inherit; font-size: 11px; letter-spacing: .08em;
  text-transform: uppercase; color: var(--fe-ui, #cfe2f2); cursor: pointer;
  background: rgba(10, 20, 28, .55); border: 1px solid rgba(139, 173, 198, .22);
}
.fe-lan-mode[data-on="true"] {
  color: #061019; background: var(--fe-accent, #7fffc4);
  border-color: var(--fe-accent, #7fffc4);
}
.fe-lan-relay { display: none; flex-direction: column; gap: 9px; }
.fe-lan-relay[data-visible="true"] { display: flex; }
.fe-lan-code { display: none; flex-direction: column; gap: 2px; align-items: center;
  padding: 8px 0; border: 1px dashed rgba(139, 173, 198, .3); }
.fe-lan-code[data-visible="true"] { display: flex; }
.fe-lan-code-label { font-size: 10px; letter-spacing: .14em; text-transform: uppercase;
  opacity: .68; }
.fe-lan-code-value { font-size: 30px; letter-spacing: .34em; line-height: 1.1;
  color: var(--fe-accent, #7fffc4); font-variant-numeric: tabular-nums; }
.fe-lan-join { display: none; align-items: center; gap: 8px; }
.fe-lan-join[data-visible="true"] { display: flex; }
.fe-lan-code-input { text-transform: uppercase; letter-spacing: .3em; max-width: 9ch; }
.fe-lan-join-button {
  padding: 5px 12px; font: inherit; font-size: 11px; letter-spacing: .08em;
  text-transform: uppercase; cursor: pointer; color: #061019;
  background: var(--fe-accent, #7fffc4); border: 0;
}
.fe-lan-error { display: none; margin: 0; font-size: 11px; color: #ff8a7a; }
.fe-lan-error[data-visible="true"] { display: block; }

.fe-lan {
  display: none; flex-direction: column; gap: 9px; width: min(430px, 92vw);
  padding: 12px 14px; text-align: left; background: rgba(6, 13, 18, .52);
  border: 1px solid rgba(139, 173, 198, .22);
}
.fe-lan[data-visible="true"] { display: flex; }
.fe-lan-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.fe-lan-title {
  margin: 0; font: 600 12px/1.2 var(--fe-ui); letter-spacing: .2em;
  text-transform: uppercase; color: rgba(220, 235, 245, .66);
}
.fe-lan-status {
  font-size: 12px; letter-spacing: .06em; color: var(--fe-accent); text-align: right;
}
.fe-lan[data-status="offline"] .fe-lan-status { color: rgba(220, 235, 245, .46); }
.fe-lan[data-status="error"] .fe-lan-status { color: #ff9b90; }
.fe-lan-field { display: flex; align-items: center; gap: 9px; }
.fe-lan-field label {
  font-size: 11px; letter-spacing: .16em; text-transform: uppercase;
  color: rgba(220, 235, 245, .58);
}
.fe-lan-input {
  flex: 1; min-width: 0; padding: 6px 9px; color: #e6f2ff;
  font: 600 14px var(--fe-ui); letter-spacing: .12em; text-transform: uppercase;
  background: rgba(3, 8, 12, .62); border: 1px solid rgba(139, 173, 198, .28);
}
.fe-lan-input:focus { outline: none; border-color: var(--fe-accent); }
.fe-lan-roster {
  margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column;
  gap: 3px; max-height: 136px; overflow-y: auto;
}
.fe-lan-peer {
  display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  font-size: 13px; color: #cfe0ee;
}
.fe-lan-peer[data-self="true"] { color: var(--fe-accent); }
.fe-lan-tag {
  font-size: 11px; letter-spacing: .14em; text-transform: uppercase;
  color: rgba(220, 235, 245, .5);
}
.fe-lan-empty, .fe-lan-note {
  margin: 0; font-size: 12px; color: rgba(220, 235, 245, .5);
}
.fe-lan-note b { color: var(--fe-accent); font-weight: 600; }
`;

export class Frontend {
  constructor({
    elements = null, onPlay = null, onResume = null, onSelectWeapon = null, onOpenClass = null,
    waitingForInput = false, storage = undefined,
  } = {}) {
    this.elements = elements;
    this.onPlay = onPlay;
    this.onResume = onResume;
    this.onSelectWeapon = onSelectWeapon;
    // Fired when the class screen opens so the game can fetch the rifles it
    // has not loaded yet. Only a player who browses classes pays for them.
    this.onOpenClass = onOpenClass;

    this.screen = waitingForInput ? 'welcome' : 'loading';
    this.playing = false;
    this.loads = new Map();
    this.expected = new Map();
    this.finished = new Set();
    this.complete = false;
    this.peak = 0;
    this.message = '';
    this.controls = [];
    this.weaponOptions = [];
    this.selectedWeapon = null;
    this.classReturnScreen = 'title';

    // The lobby starts offline on purpose: a game that never calls
    // setLanState() -- no server, or the network layer failed to load at all
    // -- reads as single-player rather than as a lobby stuck connecting.
    this.storage = storage === undefined ? defaultStorage() : storage;
    this.lan = {
      status: 'offline', peerId: null, hostId: null, peers: [], url: '', error: '',
      // Relay mode. `roomCode` is set once this client owns or has joined the
      // room; `roomRequired` means the relay already has a game and wants the
      // code. They are never both meaningful at once.
      mode: 'lan', relayUrl: '', roomCode: null, roomRequired: false, joinError: '',
    };
    this.lanName = sanitizeName(this.readStored(LAN_NAME_KEY));
    this.lan.relayUrl = String(this.readStored(RELAY_URL_KEY) ?? '');
    if (this.lan.relayUrl) this.lan.mode = 'relay';
    this.lanElements = null;
    this.lanRosterKey = null;
    this.lanEditing = false;

    this.bindElements();
    this.render();
  }

  /** True while the shell covers the game. */
  get visible() {
    return !this.playing;
  }

  get ready() {
    return this.screen === 'title' || this.screen === 'pause';
  }

  /** The first visitor gesture starts loading; waiting is not download progress. */
  startLoading() {
    if (this.screen !== 'welcome') return false;
    this.screen = 'loading';
    this.render();
    return true;
  }

  /**
   * Declare the stages the load will run and their relative weight, keyed by
   * the same labels `progress()` receives.
   *
   * Byte totals alone cannot measure this load. GLTFLoader reports progress
   * for the .gltf JSON only -- neither the 44 MB buffer it references nor the
   * 59 MB of textures behind it reaches a callback -- so a pure byte bar fills
   * on a small fraction of the payload and then sits full. Fixed stage weights
   * give a denominator known from the first frame, and `stage()` is what
   * actually completes one.
   */
  expect(weights) {
    for (const [label, weight] of Object.entries(weights ?? {})) {
      if (Number(weight) > 0) this.expected.set(label, Number(weight));
    }
    this.render();
  }

  /** Mark a declared stage finished, whatever its bytes said. */
  stage(label) {
    if (!this.expected.has(label)) return false;
    this.finished.add(label);
    this.render();
    return true;
  }

  /** How far a stage's own byte reports have got it, 0..1. */
  stageBytes(label) {
    const entry = this.loads.get(label);
    if (!entry?.total) return 0;
    return Math.min(1, entry.loaded / entry.total);
  }

  /** Overall load fraction, 0..1. */
  get fraction() {
    if (this.complete) return 1;

    if (this.expected.size) {
      let value = 0;
      let total = 0;
      for (const [label, weight] of this.expected) {
        total += weight;
        // An unfinished stage is held short of its full weight however
        // encouraging its byte count looks, so the bar cannot claim a stage
        // whose unreported buffer is still in flight.
        value += weight * (this.finished.has(label) ? 1 : Math.min(0.9, this.stageBytes(label)));
      }
      return total ? value / total : 0;
    }

    // Undeclared fallback: loads register as they start, so the denominator
    // grows and a raw ratio can walk backwards. Hold the high-water mark.
    let loaded = 0;
    let total = 0;
    for (const entry of this.loads.values()) {
      if (!entry.total) continue;
      loaded += Math.min(entry.loaded, entry.total);
      total += entry.total;
    }
    if (total > 0) this.peak = Math.max(this.peak, loaded / total);
    return this.peak;
  }

  /**
   * True once something has reported a byte total to measure against. A host
   * serving chunked or gzipped responses sends no Content-Length, so there is
   * nothing to take a percentage of and the bar has to run indeterminate.
   */
  get determinate() {
    if (this.expected.size) return true;
    for (const entry of this.loads.values()) {
      if (entry.total) return true;
    }
    return false;
  }

  get loadedBytes() {
    let loaded = 0;
    for (const entry of this.loads.values()) loaded += entry.loaded;
    return loaded;
  }

  /**
   * What to name in the status line: the first stage still outstanding, or --
   * with no stages declared -- whichever source has the most work left.
   */
  get caption() {
    // Declared stages are named in declaration order rather than by bytes
    // outstanding: the map reports its .gltf complete long before its buffer
    // arrives, so byte counts would move the caption on while the biggest
    // download is still running.
    if (this.expected.size) {
      for (const label of this.expected.keys()) {
        if (!this.finished.has(label)) return CAPTIONS[label] ?? label;
      }
      return 'finishing up';
    }

    const determinate = this.determinate;
    let worst = null;
    let score = 0;
    for (const [label, entry] of this.loads) {
      // Once anything reports a total, sources that do not report one would
      // otherwise win on raw bytes and mislabel the bar.
      if (determinate && !entry.total) continue;
      const value = entry.total
        ? entry.total - Math.min(entry.loaded, entry.total)
        : entry.loaded;
      if (value > score) {
        score = value;
        worst = label;
      }
    }
    if (!worst) return this.loads.size ? 'finishing up' : 'connecting';
    return CAPTIONS[worst] ?? worst;
  }

  progress(label, event = {}) {
    if (this.screen !== 'loading') return;
    const loaded = Number(event.loaded) || 0;
    const total = Number(event.total) || 0;
    const entry = this.loads.get(label) ?? { loaded: 0, total: 0 };
    entry.loaded = Math.max(entry.loaded, loaded);
    entry.total = Math.max(entry.total, total);
    this.loads.set(label, entry);
    this.render();
  }

  /** Loading finished; show the title screen and wait for a key or a click. */
  setReady(controls = []) {
    if (this.screen === 'error') return;
    this.controls = controls.filter(Boolean);
    this.complete = true;
    this.screen = 'title';
    this.render();
  }

  /** Supply the compact card data used by the class screen. */
  setWeapons(weapons = [], selectedId = null) {
    this.weaponOptions = (weapons ?? []).map((weapon) => {
      const entry = typeof weapon === 'string' ? { id: weapon } : weapon ?? {};
      return {
        ...entry,
        id: String(entry.id ?? '').toLowerCase(),
        ready: entry.ready !== false,
      };
    }).filter((weapon) => weapon.id);

    const requested = selectedId == null ? this.selectedWeapon : String(selectedId).toLowerCase();
    const selected = this.weaponOptions.find((weapon) => weapon.id === requested)
      ?? this.weaponOptions[0];
    this.selectedWeapon = selected?.id ?? null;
    this.render();
    return this.weaponOptions.map((weapon) => ({ id: weapon.id, ready: weapon.ready }));
  }

  /** Update one card's load state without exposing the viewmodel object. */
  setWeaponReady(id, ready = true) {
    const normalized = String(id ?? '').toLowerCase();
    const option = this.weaponOptions.find((weapon) => weapon.id === normalized);
    if (!option) return false;
    option.ready = Boolean(ready);
    this.render();
    return option.ready;
  }

  /** Open the create-a-class screen from title or pause. */
  openClass() {
    if (this.screen !== 'title' && this.screen !== 'pause') return false;
    this.classReturnScreen = this.screen;
    this.screen = 'class';
    this.playing = false;
    // The rifles other than the equipped one are only fetched from here, so
    // opening the screen is what starts them. Cards report `loading` until
    // each one calls back through setWeaponReady().
    this.onOpenClass?.();
    this.render();
    return true;
  }

  // Alias reads naturally for callers that describe the screen as a view.
  showClass() {
    return this.openClass();
  }

  /** Return to whichever shell screen opened the class picker. */
  closeClass() {
    if (this.screen !== 'class') return false;
    this.screen = this.classReturnScreen === 'pause' ? 'pause' : 'title';
    this.playing = false;
    this.render();
    return this.screen;
  }

  /** Select a loaded card; unloaded cards remain visibly unavailable. */
  chooseWeapon(id) {
    if (this.screen !== 'class') return false;
    const normalized = String(id ?? '').toLowerCase();
    const option = this.weaponOptions.find((weapon) => weapon.id === normalized);
    if (!option || !option.ready) return false;
    this.selectedWeapon = option.id;
    this.render();
    return this.selectedWeapon;
  }

  /** Confirm through the existing game-side selector, then return to shell. */
  confirmClass() {
    if (this.screen !== 'class') return false;
    const option = this.weaponOptions.find((weapon) => weapon.id === this.selectedWeapon);
    if (!option?.ready) return false;
    const result = this.onSelectWeapon?.(option.id);
    if (result === false) return false;
    const selected = option.id;
    this.closeClass();
    return result ?? selected;
  }

  // ---------- LAN lobby ----------

  readStored(key) {
    try {
      return this.storage?.getItem(key) ?? '';
    } catch {
      // Storage blocked. The lobby simply forgets the name between sessions.
      return '';
    }
  }

  writeStored(key, value) {
    try {
      this.storage?.setItem(key, value);
    } catch {
      // Nothing to do; the name still applies to this session.
    }
  }

  /** The name this player goes by. Always a valid wire name, never empty. */
  getLanName() {
    return this.lanName;
  }

  /**
   * Set and persist the display name. `protocol.sanitizeName` owns the rules
   * -- length, control characters, whitespace, casing -- so the lobby cannot
   * drift from what the server and the scoreboard will accept.
   *
   * This only stores and renders. Announcing the change is `action()`'s job,
   * so the game is not told about a name it set itself.
   */
  setLanName(name) {
    const next = sanitizeName(name, this.lanName || undefined);
    if (next !== this.lanName) {
      this.lanName = next;
      this.writeStored(LAN_NAME_KEY, next);
    }
    this.render();
    return this.lanName;
  }

  /**
   * Mirror the network layer's view of the lobby. Fields left undefined keep
   * their current value, so a status change does not have to re-send the
   * roster and a dropped connection does not blank the names mid-frame.
   */
  setLanState({
    status, peerId, hostId, peers, url, error,
    mode, roomCode, roomRequired, joinError,
  } = {}) {
    const lan = this.lan;
    if (status !== undefined) lan.status = LAN_STATUSES.includes(status) ? status : 'offline';
    if (mode !== undefined) lan.mode = NET_MODES.includes(mode) ? mode : 'lan';
    if (roomCode !== undefined) lan.roomCode = roomCode == null ? null : String(roomCode);
    if (roomRequired !== undefined) lan.roomRequired = Boolean(roomRequired);
    if (joinError !== undefined) lan.joinError = joinError == null ? '' : String(joinError);
    if (peerId !== undefined) lan.peerId = peerId == null ? null : String(peerId);
    if (hostId !== undefined) lan.hostId = hostId == null ? null : String(hostId);
    if (peers !== undefined) lan.peers = lanPeers(peers);
    if (url !== undefined) lan.url = url == null ? '' : String(url);
    if (error !== undefined) {
      lan.error = error == null ? '' : String(error instanceof Error ? error.message : error);
    }
    this.render();
    return this.getLanState();
  }

  /** The roster as drawn: who is host, who is you. */
  get lanRoster() {
    return this.lan.peers.map((peer) => {
      const host = peer.id === this.lan.hostId;
      const self = peer.id === this.lan.peerId;
      const tags = [host ? 'host' : null, self ? 'you' : null].filter(Boolean);
      return { id: peer.id, name: peer.name, host, self, tag: tags.join(' · ') };
    });
  }

  get lanStatusText() {
    const { status, error, peers } = this.lan;
    if (status === 'error') return error ? `Error — ${error}` : 'Connection failed';
    if (status === 'connecting') return 'Connecting…';
    if (status === 'connected') return `Connected · ${peers.length} in lobby`;
    return 'Offline — single player';
  }

  /** The line the host reads out to the room. */
  get lanNoteText() {
    if (this.lan.mode === 'relay') {
      if (this.lan.roomCode) return 'Give the code above to your friends.';
      if (this.lan.roomRequired) return 'A game is already running here. Enter its code to join.';
      if (this.lan.status === 'connecting') return 'Reaching the relay…';
      return 'Paste the address of a relay to play with people anywhere.';
    }
    if (this.lan.url) return `Others on this WiFi join at ${this.lan.url}`;
    if (this.lan.status === 'offline') return 'No LAN server found. Playing solo.';
    return '';
  }

  /** The code as displayed: spaced, because it gets read out loud. */
  get roomCodeText() {
    return this.lan.roomCode ? this.lan.roomCode.split('').join(' ') : '';
  }

  getRelayUrl() {
    return this.lan.relayUrl;
  }

  /** Persist a pasted relay address. Returns the stored value. */
  setRelayUrl(url) {
    const next = String(url ?? '').trim();
    if (next !== this.lan.relayUrl) {
      this.lan.relayUrl = next;
      this.writeStored(RELAY_URL_KEY, next);
    }
    this.render();
    return this.lan.relayUrl;
  }

  /** Compact, serializable lobby view for the debug API. */
  getLanState() {
    return {
      status: this.lan.status,
      peerId: this.lan.peerId,
      hostId: this.lan.hostId,
      url: this.lan.url,
      error: this.lan.error,
      name: this.lanName,
      peers: this.lanRoster,
      mode: this.lan.mode,
      relayUrl: this.lan.relayUrl,
      roomCode: this.lan.roomCode,
      roomRequired: this.lan.roomRequired,
      joinError: this.lan.joinError,
    };
  }

  fail(message) {
    this.screen = 'error';
    this.playing = false;
    this.message = String(message ?? 'Unable to start');
    this.render();
  }

  /**
   * Ask to start or resume. The shell deliberately stays up until the game
   * confirms with `enter()`: a pointer lock request can be refused, and a
   * hidden shell with no lock would leave nothing on screen to click.
   */
  play() {
    if (!this.ready) return false;
    if (this.screen === 'pause') this.onResume?.();
    else this.onPlay?.();
    return true;
  }

  /** Pointer lock was acquired, or automation took over. Drop the shell. */
  enter() {
    this.playing = true;
    this.render();
    return true;
  }

  /** Called when the game gives up pointer lock, by Esc or otherwise. */
  suspend() {
    if (!this.ready || !this.playing) return false;
    this.playing = false;
    this.screen = 'pause';
    this.render();
    return true;
  }

  /** Compact, serializable view for the debug API and smoke tests. */
  getState() {
    return {
      screen: this.screen,
      visible: this.visible,
      percent: Math.round(this.fraction * 100),
      caption: this.screen === 'loading' ? this.caption : '',
      selectedWeapon: this.selectedWeapon,
      lan: { status: this.lan.status, name: this.lanName, peers: this.lan.peers.length },
    };
  }

  // ---------- DOM ----------

  bindElements() {
    const el = this.elements;
    if (!el) return;
    // A click anywhere on the shell starts or resumes, matching the title
    // prompt. Buttons stop the event so they do not also trigger it.
    el.root?.addEventListener('click', () => this.play());
    for (const button of el.buttons ?? []) {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.action(button.dataset.action);
      });
    }
    for (const card of el.classCards ?? []) {
      card.addEventListener('click', (event) => {
        event.stopPropagation();
        this.chooseWeapon(card.dataset.weaponId);
      });
    }
    this.buildLanPanel();
  }

  /**
   * Build the lobby panel from script.
   *
   * The shell's other screens are authored in index.html, but the panel is
   * built here so a page that predates LAN play gains it without an edit --
   * and so the markup and the code that fills it cannot drift apart. Its
   * stylesheet is injected once, using the same `--fe-accent` and `--fe-ui`
   * tokens as the rest of the menu.
   */
  buildLanPanel() {
    const el = this.elements;
    const doc = typeof document === 'undefined' ? null : document;
    if (!el?.root || !doc?.createElement) return null;

    const make = (tag, className, parent, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      parent?.appendChild?.(node);
      return node;
    };

    if (!doc.getElementById?.('fe-lan-style')) {
      const style = make('style', null, doc.head);
      style.id = 'fe-lan-style';
      style.textContent = LAN_CSS;
    }

    const panel = doc.createElement('section');
    panel.className = 'fe-lan';
    panel.dataset.visible = 'false';
    panel.setAttribute?.('aria-label', 'LAN game');
    // The shell starts the game on any click, so the panel swallows its own.
    // Without this, reaching for the name field would deploy you instead.
    panel.addEventListener('click', (event) => event.stopPropagation());

    const head = make('div', 'fe-lan-head', panel);
    make('h2', 'fe-lan-title', head, 'Multiplayer');
    const status = make('span', 'fe-lan-status', head, '');


    const field = make('div', 'fe-lan-field', panel);
    const label = make('label', null, field, 'Name');
    const name = make('input', 'fe-lan-input', field);
    name.type = 'text';
    name.id = 'fe-lan-name';
    name.maxLength = LIMITS.MAX_NAME_LENGTH;
    name.value = this.lanName;
    label.setAttribute?.('for', name.id);
    // Committed edits, not keystrokes: one `hello` per name the player
    // settles on rather than one per letter typed.
    name.addEventListener('input', () => { this.lanEditing = true; });
    name.addEventListener('change', () => this.action('lan-name', name.value));
    name.addEventListener('blur', () => this.action('lan-name', name.value));

    // Two deliberate modes rather than one guessing. LAN needs nothing typed;
    // relay is a choice you make, so it is a choice you click.
    const modes = make('div', 'fe-lan-modes', panel);
    const modeButtons = NET_MODES.map((mode) => {
      const button = make('button', 'fe-lan-mode', modes,
        mode === 'lan' ? 'This WiFi' : 'Relay');
      button.type = 'button';
      button.dataset.mode = mode;
      button.addEventListener('click', () => this.action('net-mode', mode));
      return button;
    });

    const relay = make('div', 'fe-lan-relay', panel);
    const relayField = make('div', 'fe-lan-field', relay);
    const relayLabel = make('label', null, relayField, 'Relay');
    const relayInput = make('input', 'fe-lan-input', relayField);
    relayInput.type = 'text';
    relayInput.id = 'fe-relay-url';
    relayInput.placeholder = 'https://your-relay.example.com';
    relayInput.spellcheck = false;
    relayInput.value = this.lan.relayUrl;
    relayLabel.setAttribute?.('for', relayInput.id);
    relayInput.addEventListener('input', () => { this.relayEditing = true; });
    relayInput.addEventListener('change', () => this.action('relay-url', relayInput.value));
    relayInput.addEventListener('blur', () => this.action('relay-url', relayInput.value));

    // Shown to whoever opened the room: the thing they read out.
    const codeBox = make('div', 'fe-lan-code', relay);
    make('span', 'fe-lan-code-label', codeBox, 'Your room code');
    const codeValue = make('strong', 'fe-lan-code-value', codeBox, '');

    // Shown to everyone else: a game is already running, so type the code.
    const joinBox = make('div', 'fe-lan-join', relay);
    const joinLabel = make('label', null, joinBox, 'Room code');
    const joinInput = make('input', 'fe-lan-input fe-lan-code-input', joinBox);
    joinInput.type = 'text';
    joinInput.id = 'fe-relay-code';
    joinInput.maxLength = ROOM_CODE_LENGTH;
    joinInput.placeholder = 'ABCD';
    joinInput.spellcheck = false;
    joinLabel.setAttribute?.('for', joinInput.id);
    const submitCode = () => {
      const code = normalizeRoomCode(joinInput.value);
      joinInput.value = code;
      if (code.length === ROOM_CODE_LENGTH) this.action('relay-code', code);
    };
    joinInput.addEventListener('input', () => {
      joinInput.value = normalizeRoomCode(joinInput.value);
      // Four characters is the whole code, so there is nothing to confirm.
      if (joinInput.value.length === ROOM_CODE_LENGTH) submitCode();
    });
    joinInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submitCode();
    });
    const joinButton = make('button', 'fe-lan-join-button', joinBox, 'Join');
    joinButton.type = 'button';
    joinButton.addEventListener('click', submitCode);
    const joinError = make('p', 'fe-lan-error', relay, '');

    const roster = make('ul', 'fe-lan-roster', panel);
    const note = make('p', 'fe-lan-note', panel, '');

    const content = el.root.querySelector?.('.fe-content') ?? el.root;
    const anchor = el.root.querySelector?.('.fe-controls');
    if (anchor && content.insertBefore) content.insertBefore(panel, anchor);
    else content.appendChild?.(panel);

    this.lanElements = {
      panel, status, name, roster, note, make,
      modeButtons, relay, relayInput, codeBox, codeValue, joinBox, joinInput, joinError,
    };
    return panel;
  }

  renderLan() {
    const lan = this.lanElements;
    if (!lan) return;
    lan.panel.dataset.visible = String(this.screen === 'title' || this.screen === 'pause');
    lan.panel.dataset.status = this.lan.status;
    lan.panel.dataset.mode = this.lan.mode;
    lan.status.textContent = this.lanStatusText;
    lan.note.textContent = this.lanNoteText;

    for (const button of lan.modeButtons ?? []) {
      button.dataset.on = String(button.dataset.mode === this.lan.mode);
    }
    if (lan.relay) {
      const relayMode = this.lan.mode === 'relay';
      lan.relay.dataset.visible = String(relayMode);
      // The code box and the code prompt are mutually exclusive: you either
      // opened this room or you are trying to get into it.
      lan.codeBox.dataset.visible = String(relayMode && Boolean(this.lan.roomCode));
      lan.codeValue.textContent = this.roomCodeText;
      lan.joinBox.dataset.visible = String(relayMode && this.lan.roomRequired);
      lan.joinError.textContent = this.lan.joinError;
      lan.joinError.dataset.visible = String(Boolean(this.lan.joinError));
      if (!this.relayEditing && lan.relayInput.value !== this.lan.relayUrl) {
        lan.relayInput.value = this.lan.relayUrl;
      }
    }
    // Never overwrite a field the player is mid-edit in; the sanitized value
    // lands on blur instead, where it cannot move the caret under them.
    if (!this.lanEditing && lan.name.value !== this.lanName) lan.name.value = this.lanName;

    const roster = this.lanRoster;
    // render() runs on every progress event, so the list is only rebuilt when
    // it would actually differ.
    const key = roster.map((peer) => `${peer.id} ${peer.name} ${peer.tag}`).join('');
    if (key === this.lanRosterKey) return;
    this.lanRosterKey = key;

    const rows = roster.map((peer) => {
      const row = lan.make('li', 'fe-lan-peer');
      row.dataset.peerId = peer.id;
      row.dataset.host = String(peer.host);
      row.dataset.self = String(peer.self);
      lan.make('span', 'fe-lan-name', row, peer.name);
      lan.make('span', 'fe-lan-tag', row, peer.tag);
      return row;
    });
    if (!rows.length) rows.push(lan.make('li', 'fe-lan-empty', null, 'Nobody else on the LAN yet'));
    lan.roster.replaceChildren(...rows);
  }

  /** Shell buttons, including class navigation and card confirmation. */
  action(name, value) {
    if (name === 'resume') return this.play();
    if (name === 'class') return this.openClass();
    if (name === 'class-back') return this.closeClass();
    if (name === 'class-confirm') return this.confirmClass();
    if (name === 'lan-name') {
      // The player edited the name, so the game is told to send a `hello`.
      // Only a name that actually changed is announced: a field that blurs
      // straight after a change event must not send the same name twice.
      this.lanEditing = false;
      const previous = this.lanName;
      const next = this.setLanName(value);
      if (next !== previous) this.elements?.onAction?.(name, next);
      return next;
    }
    // Forward the value too. Dropping it silently broke every control that
    // carries one -- the relay mode button did nothing, and the relay URL
    // field cleared what had just been pasted.
    return this.elements?.onAction?.(name, value);
  }

  render() {
    const el = this.elements;
    if (!el) return;
    this.renderLan();
    const loading = this.screen === 'loading';
    const determinate = !loading || this.determinate;

    if (el.root) {
      el.root.dataset.screen = this.screen;
      el.root.dataset.determinate = String(determinate);
      el.root.style.display = this.visible ? 'flex' : 'none';
      el.root.classList.toggle('ready', this.ready);
    }
    // An indeterminate bar is left to the stylesheet to sweep, so clear the
    // inline width rather than pinning it to a percentage that means nothing.
    if (el.bar) el.bar.style.width = determinate ? `${(this.fraction * 100).toFixed(1)}%` : '';
    if (el.percent) {
      el.percent.textContent = !loading ? ''
        : determinate ? `${Math.round(this.fraction * 100)}%`
        : `${(this.loadedBytes / 1048576).toFixed(1)} MB`;
    }
    if (el.caption) el.caption.textContent = loading ? `${this.caption}…` : '';
    if (el.message) el.message.textContent = this.message;
    if (el.controls && this.controls.length) el.controls.textContent = this.controls.join('\n');
    for (const card of el.classCards ?? []) {
      const option = this.weaponOptions.find((weapon) => weapon.id === card.dataset.weaponId);
      const selected = option?.id === this.selectedWeapon;
      card.dataset.selected = String(selected);
      card.dataset.ready = String(Boolean(option?.ready));
      card.disabled = !option?.ready;
      const state = card.querySelector('[data-card-state]');
      if (state) state.textContent = option?.ready ? (selected ? 'equipped' : 'ready') : 'loading';
    }
    const selected = this.weaponOptions.find((weapon) => weapon.id === this.selectedWeapon);
    if (el.classSelection) {
      el.classSelection.textContent = selected ? `${selected.name ?? selected.id} selected` : 'Select a rifle';
    }
    if (el.classConfirm) el.classConfirm.disabled = !selected?.ready;
  }
}
