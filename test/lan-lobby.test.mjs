import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * The LAN lobby panel in `frontend.js`.
 *
 * `frontend.test.mjs` tests the shell with no `elements` at all, which is what
 * the state machine was built for. The lobby has to build its own DOM -- the
 * panel is not in index.html -- so this file adds the smallest fake document
 * that exercises that path: create, append, replace, and dispatch. It is a
 * stand-in for a browser, not a DOM implementation, and it is deliberately
 * installed before `frontend.js` reaches for `document`.
 */
function fakeDocument() {
  const matches = (node, selector) => node.className?.split(' ').includes(selector.slice(1));
  const find = (node, selector) => {
    for (const child of node.children) {
      if (matches(child, selector)) return child;
      const nested = find(child, selector);
      if (nested) return nested;
    }
    return null;
  };

  const create = (tag) => {
    let text = '';
    const node = {
      tagName: String(tag).toUpperCase(),
      className: '',
      children: [],
      dataset: {},
      style: {},
      attributes: {},
      handlers: new Map(),
      value: '',
      classList: { toggle() {} },
      appendChild(child) {
        node.children.push(child);
        return child;
      },
      insertBefore(child, before) {
        const at = node.children.indexOf(before);
        node.children.splice(at < 0 ? node.children.length : at, 0, child);
        return child;
      },
      replaceChildren(...next) {
        node.children = next;
      },
      setAttribute(key, value) {
        node.attributes[key] = String(value);
      },
      addEventListener(type, handler) {
        node.handlers.set(type, handler);
      },
      /** Fire a listener the way a browser would, event object included. */
      dispatch(type, event = {}) {
        node.handlers.get(type)?.({ stopPropagation() {}, ...event });
      },
      querySelector: (selector) => find(node, selector),
    };
    Object.defineProperty(node, 'textContent', {
      get: () => (node.children.length
        ? node.children.map((child) => child.textContent).filter(Boolean).join(' ')
        : text),
      set: (value) => {
        text = String(value);
        node.children = [];
      },
    });
    return node;
  };

  const head = create('head');
  return {
    head,
    createElement: create,
    getElementById: (id) => head.children.find((child) => child.id === id) ?? null,
  };
}

globalThis.document = fakeDocument();
const { Frontend, LAN_NAME_KEY } = await import('../export/web/frontend.js');

/** The parts of index.html the shell binds to, rebuilt in the fake document. */
function shell() {
  const root = document.createElement('div');
  const content = document.createElement('div');
  content.className = 'fe-content';
  const controls = document.createElement('pre');
  controls.className = 'fe-controls';
  root.appendChild(content);
  content.appendChild(controls);
  return { root, content, controls };
}

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    read: (key) => data.get(key),
  };
}

/** localStorage in a sandboxed frame: every access throws rather than returning null. */
const hostileStorage = {
  getItem() { throw new Error('storage blocked'); },
  setItem() { throw new Error('storage blocked'); },
};

function lobby(options = {}) {
  const parts = shell();
  const actions = [];
  const frontend = new Frontend({
    storage: null,
    ...options,
    elements: { root: parts.root, onAction: (name, value) => actions.push([name, value]) },
  });
  const panel = parts.content.querySelector('.fe-lan');
  return {
    frontend,
    actions,
    panel,
    ...parts,
    status: panel.querySelector('.fe-lan-status'),
    name: panel.querySelector('.fe-lan-input'),
    roster: panel.querySelector('.fe-lan-roster'),
    note: panel.querySelector('.fe-lan-note'),
    gamesBox: panel.querySelector('.fe-lan-games'),
    games: panel.querySelector('.fe-lan-game-list'),
    joined: panel.querySelector('.fe-lan-joined'),
    joinedName: panel.querySelector('.fe-lan-joined-name'),
    back: panel.querySelector('.fe-lan-back'),
  };
}

/** The discovered-games list as drawn, one entry per row. */
const gameRows = (view) => view.games.children.map((row) => ({
  text: row.textContent,
  id: row.dataset.gameId,
  compatible: row.dataset.compatible,
  join: row.querySelector('.fe-lan-game-join'),
}));

const A_GAME = {
  id: 'aaa1', name: 'Priyas MacBook Air', address: '192.168.1.9', port: 8000,
  url: 'http://192.168.1.9:8000', players: 1, version: '1.0.0', compatible: true,
};

const rows = (view) => view.roster.children.map((row) => ({
  text: row.textContent,
  host: row.dataset.host,
  self: row.dataset.self,
  id: row.dataset.peerId,
}));

test('the panel is built into the shell and sits before the controls block', () => {
  const view = lobby();
  assert.ok(view.panel, 'the lobby builds its own markup; index.html has none');
  assert.equal(view.content.children.indexOf(view.panel), 0);
  assert.equal(view.content.children.at(-1), view.controls);
  assert.equal(view.name.maxLength, 16, 'the field cannot outrun the wire limit');
  assert.equal(document.getElementById('fe-lan-style').tagName, 'STYLE');

  const second = lobby();
  assert.ok(second.panel);
  assert.equal(document.head.children.filter((child) => child.id === 'fe-lan-style').length, 1,
    'the stylesheet is injected once, not once per shell');
});

test('with no server the lobby says offline and the title screen still plays', () => {
  const plays = [];
  const view = lobby({ onPlay: () => plays.push('play') });
  view.frontend.setReady();

  assert.equal(view.frontend.getState().lan.status, 'offline');
  assert.equal(view.status.textContent, 'Offline — single player');
  assert.match(view.note.textContent, /Playing solo/);
  assert.equal(view.roster.children[0].textContent, 'Nobody else on the LAN yet');
  assert.equal(view.panel.dataset.visible, 'true', 'the lobby shows on the title screen');

  assert.equal(view.frontend.play(), true, 'a missing server never blocks the game');
  assert.deepEqual(plays, ['play']);
});

test('the panel is only on screen where it can be used', () => {
  const view = lobby();
  assert.equal(view.panel.dataset.visible, 'false', 'not over the loading bar');
  view.frontend.setReady();
  assert.equal(view.panel.dataset.visible, 'true');
  view.frontend.enter();
  view.frontend.suspend();
  assert.equal(view.panel.dataset.visible, 'true', 'pause is a lobby too');
  view.frontend.openClass();
  assert.equal(view.panel.dataset.visible, 'false');
});

test('the roster marks the host and yourself, and names the join URL', () => {
  const view = lobby();
  view.frontend.setReady();
  view.frontend.setLanState({
    status: 'connected',
    peerId: 'p2',
    hostId: 'p1',
    peers: [{ id: 'p1', name: 'ada' }, { id: 'p2', name: 'bo' }, { id: 'p3' }],
    url: 'http://192.168.1.42:8000',
  });

  assert.deepEqual(rows(view), [
    { text: 'ADA host', host: 'true', self: 'false', id: 'p1' },
    { text: 'BO you', host: 'false', self: 'true', id: 'p2' },
    { text: 'P3', host: 'false', self: 'false', id: 'p3' },
  ]);
  assert.equal(view.status.textContent, 'Connected · 3 in lobby');
  assert.equal(view.note.textContent, 'Others on this WiFi join at http://192.168.1.42:8000');

  // Hosting yourself is one row carrying both markers, not two rows.
  view.frontend.setLanState({ hostId: 'p2' });
  assert.deepEqual(rows(view).map((row) => row.text), ['ADA', 'BO host · you', 'P3']);

  view.frontend.setLanState({ peers: [{ id: 'p2', name: 'bo' }] });
  assert.deepEqual(rows(view).map((row) => row.id), ['p2']);
  assert.equal(view.status.textContent, 'Connected · 1 in lobby');
});

test('the roster ignores nameless, duplicate, and malformed peers', () => {
  const view = lobby();
  view.frontend.setLanState({
    peers: [null, { id: '' }, 'p9', { id: 'p9', name: 'again' }, { id: 'p8', name: '  a  b  ' }],
  });
  assert.deepEqual(view.frontend.getLanState().peers.map((peer) => peer.name), ['P9', 'A B']);
});

test('status transitions carry the error text and keep the roster', () => {
  const view = lobby();
  view.frontend.setReady();
  const seen = [];

  view.frontend.setLanState({ status: 'connecting' });
  seen.push([view.panel.dataset.status, view.status.textContent]);

  view.frontend.setLanState({
    status: 'connected', peerId: 'p1', hostId: 'p1', peers: [{ id: 'p1', name: 'ada' }],
  });
  seen.push([view.panel.dataset.status, view.status.textContent]);

  view.frontend.setLanState({ status: 'error', error: new Error('ECONNREFUSED') });
  seen.push([view.panel.dataset.status, view.status.textContent]);

  view.frontend.setLanState({ status: 'error', error: '' });
  seen.push([view.panel.dataset.status, view.status.textContent]);

  view.frontend.setLanState({ status: 'nonsense' });
  seen.push([view.panel.dataset.status, view.status.textContent]);

  assert.deepEqual(seen, [
    ['connecting', 'Connecting…'],
    ['connected', 'Connected · 1 in lobby'],
    ['error', 'Error — ECONNREFUSED'],
    ['error', 'Connection failed'],
    ['offline', 'Offline — single player'],
  ]);
  assert.deepEqual(rows(view).map((row) => row.id), ['p1'],
    'a status change on its own does not blank the names');
});

test('editing the name sanitises it, persists it, and announces it once', () => {
  const storage = fakeStorage();
  const view = lobby({ storage });
  assert.equal(view.frontend.getLanName(), 'PLAYER', 'there is always a valid wire name');
  assert.equal(view.name.value, 'PLAYER');

  view.name.value = '  shubh ratrey with a very long tail  ';
  view.name.dispatch('input');
  view.name.dispatch('change');

  assert.equal(view.frontend.getLanName(), 'SHUBH RATREY WIT', '16 characters, control chars gone');
  assert.equal(view.name.value, 'SHUBH RATREY WIT', 'the field echoes what the wire will carry');
  assert.equal(storage.read(LAN_NAME_KEY), 'SHUBH RATREY WIT');
  assert.equal(LAN_NAME_KEY, 'hijacked.lanName');
  assert.deepEqual(view.actions, [['lan-name', 'SHUBH RATREY WIT']]);

  // A field that blurs straight after a change must not send a second hello.
  view.name.dispatch('blur');
  assert.equal(view.actions.length, 1);

  // Clearing the field keeps the name it had rather than reverting to PLAYER.
  view.name.value = '   ';
  view.name.dispatch('change');
  assert.equal(view.frontend.getLanName(), 'SHUBH RATREY WIT');
  assert.equal(view.actions.length, 1);

  const returning = lobby({ storage });
  assert.equal(returning.frontend.getLanName(), 'SHUBH RATREY WIT', 'the name survives a reload');
  assert.equal(returning.name.value, 'SHUBH RATREY WIT');
});

test('setLanName is the quiet path: it stores and renders but never announces', () => {
  const storage = fakeStorage();
  const view = lobby({ storage });
  assert.equal(view.frontend.setLanName('ada'), 'ADA');
  assert.equal(view.name.value, 'ADA');
  assert.equal(storage.read(LAN_NAME_KEY), 'ADA');
  assert.deepEqual(view.actions, [], 'a name the game set itself is not news to the game');
});

test('a field mid-edit is not rewritten under the player', () => {
  const view = lobby();
  view.name.value = 'partial ty';
  view.name.dispatch('input');
  view.frontend.setLanState({ status: 'connecting' });
  assert.equal(view.name.value, 'partial ty', 'render must not move the caret while typing');
  view.name.dispatch('blur');
  assert.equal(view.name.value, 'PARTIAL TY');
});

test('a localStorage that throws leaves the lobby working', () => {
  const view = lobby({ storage: hostileStorage });
  assert.equal(view.frontend.getLanName(), 'PLAYER');
  assert.equal(view.frontend.setLanName('ada'), 'ADA', 'the name still applies to this session');
  assert.equal(view.name.value, 'ADA');
  view.frontend.setReady();
  assert.equal(view.frontend.play(), true);
});

test('the panel swallows its own clicks so reaching for it cannot deploy you', () => {
  const view = lobby();
  let stopped = false;
  view.panel.dispatch('click', { stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true);
});

test('a shell action carries its value, not just its name', () => {
  // The generic forward used to drop the second argument, so every relay
  // control reached the game with an undefined value: the mode button did
  // nothing and the URL field cleared what had just been pasted. Only
  // `lan-name` worked, because it is special-cased above the fallthrough.
  const seen = [];
  const frontend = new Frontend({
    storage: null,
    elements: { onAction: (name, value) => seen.push([name, value]) },
  });

  frontend.action('net-mode', 'relay');
  frontend.action('relay-url', 'https://relay.example.com');
  frontend.action('relay-code', 'K7M2');
  assert.deepEqual(seen, [
    ['net-mode', 'relay'],
    ['relay-url', 'https://relay.example.com'],
    ['relay-code', 'K7M2'],
  ]);
});

test('an action with no value still forwards cleanly', () => {
  const seen = [];
  const frontend = new Frontend({
    storage: null,
    elements: { onAction: (name, value) => seen.push([name, value]) },
  });
  frontend.action('respawn');
  assert.deepEqual(seen, [['respawn', undefined]]);
});

test('a public origin does not advertise itself for WiFi play', () => {
  // This is what sent someone hunting a fault that was not there: the panel
  // fell back to location.origin, so a page served from a public deployment
  // read "Others on this WiFi join at https://playops.netlify.app" -- an
  // address nobody on the WiFi can use, for a mode that cannot work there.
  const frontend = new Frontend({ storage: null });
  frontend.setLanState({ status: 'offline', url: '', lanPossible: false });
  const note = frontend.lanNoteText;
  assert.doesNotMatch(note, /join at/, note);
  assert.match(note, /npm run lan/);
  assert.match(note, /Relay/);
});

test('a real LAN server is still advertised by the address it gave us', () => {
  const frontend = new Frontend({ storage: null });
  frontend.setLanState({
    status: 'connected', url: 'http://192.168.1.140:8000', lanPossible: true,
  });
  assert.equal(frontend.lanNoteText, 'Others on this WiFi join at http://192.168.1.140:8000');
});

test('a private origin with no server says so without blaming the mode', () => {
  const frontend = new Frontend({ storage: null });
  frontend.setLanState({ status: 'offline', url: '', lanPossible: true });
  assert.equal(frontend.lanNoteText, 'No LAN server found. Playing solo.');
});

test('the lobby state machine works with no DOM at all', () => {
  const frontend = new Frontend({ storage: null });
  frontend.setLanState({ status: 'connected', peerId: 'p1', hostId: 'p2', peers: [{ id: 'p1' }] });
  assert.deepEqual(frontend.getLanState(), {
    status: 'connected',
    peerId: 'p1',
    hostId: 'p2',
    url: '',
    error: '',
    name: 'PLAYER',
    peers: [{ id: 'p1', name: 'P1', host: false, self: true, tag: 'you' }],
    mode: 'lan',
    relayUrl: '',
    roomCode: null,
    roomRequired: false,
    joinError: '',
    lanPossible: true,
    games: [],
    joinedGame: null,
  });
  assert.deepEqual(frontend.getState().lan, { status: 'connected', name: 'PLAYER', peers: 1 });
});

test('games on this WiFi are listed with a name, a headcount and a Join', () => {
  const view = lobby();
  view.frontend.setReady();
  assert.equal(view.gamesBox.dataset.visible, 'false', 'no games means no empty heading');

  view.frontend.setLanState({
    games: [
      A_GAME,
      { ...A_GAME, id: 'bbb2', name: 'Shubhams MacBook', address: '192.168.1.42', players: 3 },
    ],
  });

  assert.equal(view.gamesBox.dataset.visible, 'true');
  assert.match(view.gamesBox.textContent, /Games on this WiFi/);
  assert.deepEqual(gameRows(view).map((row) => [row.id, row.text]), [
    ['aaa1', 'Priyas MacBook Air 1 player Join'],
    ['bbb2', 'Shubhams MacBook 3 players Join'],
  ]);

  view.frontend.setLanState({ games: [] });
  assert.equal(view.gamesBox.dataset.visible, 'false', 'the last game closing empties the list');
  assert.deepEqual(gameRows(view), []);
});

test('an incompatible game says so instead of offering a Join', () => {
  const view = lobby();
  view.frontend.setLanState({
    games: [
      { ...A_GAME, id: 'old', name: 'Rahuls Mac', compatible: false, version: '0.9.0' },
      A_GAME,
    ],
  });

  // Sorted by name, so Priya's comes before Rahul's whatever order they arrived.
  const [current, older] = gameRows(view);
  assert.equal(older.id, 'old');
  assert.equal(older.compatible, 'false');
  assert.equal(older.join, null, 'two builds that cannot talk must never be allowed to try');
  assert.match(older.text, /different version/);
  assert.ok(current.join, 'the compatible game is still joinable');
});

test('clicking Join forwards the address the beacon was seen at', () => {
  const view = lobby();
  view.frontend.setLanState({ games: [A_GAME] });

  gameRows(view)[0].join.dispatch('click');
  assert.deepEqual(view.actions, [
    ['join-game', { address: '192.168.1.9', port: 8000, name: 'Priyas MacBook Air' }],
  ]);
});

test('a Join click does not also deploy you into your own match', () => {
  const plays = [];
  const view = lobby({ onPlay: () => plays.push('play') });
  view.frontend.setReady();
  view.frontend.setLanState({ games: [A_GAME] });

  let stopped = false;
  gameRows(view)[0].join.dispatch('click', { stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true);
  assert.deepEqual(plays, []);
});

test('once joined the panel names the game and offers the way back', () => {
  const view = lobby();
  view.frontend.setReady();
  view.frontend.setLanState({
    games: [A_GAME],
    joinedGame: { name: 'Priyas MacBook Air', url: 'http://192.168.1.9:8000' },
  });

  assert.equal(view.joined.dataset.visible, 'true');
  assert.equal(view.joinedName.textContent, 'Playing on Priyas MacBook Air');
  assert.equal(view.gamesBox.dataset.visible, 'false',
    'the list is for choosing a game, not for reading while in one');

  view.back.dispatch('click');
  assert.deepEqual(view.actions, [['leave-game', undefined]]);

  view.frontend.setLanState({ joinedGame: null });
  assert.equal(view.joined.dataset.visible, 'false');
  assert.equal(view.gamesBox.dataset.visible, 'true');
});

test('the list belongs to LAN mode, not to a pasted relay address', () => {
  const view = lobby();
  view.frontend.setLanState({ games: [A_GAME] });
  assert.equal(view.gamesBox.dataset.visible, 'true');
  view.frontend.setLanState({ mode: 'relay' });
  assert.equal(view.gamesBox.dataset.visible, 'false');
  view.frontend.setLanState({ mode: 'lan' });
  assert.equal(view.gamesBox.dataset.visible, 'true');
});

test('games with nothing to connect to are dropped rather than drawn', () => {
  const view = lobby();
  view.frontend.setLanState({
    games: [
      null,
      'nonsense',
      { id: '', address: '10.0.0.1', port: 8000 },
      { id: 'noaddr', port: 8000 },
      { id: 'noport', address: '10.0.0.1' },
      { id: 'badport', address: '10.0.0.1', port: 99999 },
      { id: 'dupe', address: '10.0.0.1', port: 8000, name: 'Mac' },
      { id: 'dupe', address: '10.0.0.2', port: 8000, name: 'Mac again' },
    ],
  });
  assert.deepEqual(view.frontend.getLanState().games.map((game) => game.id), ['dupe']);
  assert.equal(view.frontend.getLanState().games[0].name, 'Mac');
});

test('a nameless game is still identifiable, and unknown compatibility is optimistic', () => {
  const view = lobby();
  view.frontend.setLanState({ games: [{ id: 'g', address: '10.0.0.5', port: 8001 }] });
  const [row] = gameRows(view);
  assert.equal(row.text, '10.0.0.5 0 players Join');
  assert.ok(row.join);
});
