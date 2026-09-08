// Guards the offline-LAN boot path. The game is played on WiFi with no uplink,
// so a single CDN URL sneaking back into index.html breaks every guest.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'export', 'web');
const VENDOR = join(WEB, 'vendor');
const INDEX = join(WEB, 'index.html');

const html = readFileSync(INDEX, 'utf8');

function importmap() {
  const open = '<script type="importmap">';
  const start = html.indexOf(open);
  assert.notEqual(start, -1, 'index.html has no importmap');
  const end = html.indexOf('</script>', start);
  assert.notEqual(end, -1, 'importmap script tag is unterminated');
  return {
    raw: html.slice(start + open.length, end),
    imports: JSON.parse(html.slice(start + open.length, end)).imports,
  };
}

function nonEmptyFile(path) {
  assert.ok(existsSync(path), `missing ${path}`);
  assert.ok(statSync(path).isFile(), `${path} is not a file`);
  assert.ok(statSync(path).size > 0, `${path} is empty`);
}

test('vendor directory holds every third-party entry point', () => {
  assert.ok(existsSync(VENDOR), 'export/web/vendor is missing — run `npm run vendor`');
  const entryPoints = [
    'three/build/three.module.js',
    // three.module.js imports this relatively; missing it is a boot failure.
    'three/build/three.core.js',
    'three/examples/jsm/loaders/GLTFLoader.js',
    'three/examples/jsm/loaders/KTX2Loader.js',
    'three/examples/jsm/libs/meshopt_decoder.module.js',
    // KTX2Loader fetches these by URL, so no import graph reaches them and the
    // map's glTF lists KHR_texture_basisu in extensionsRequired.
    'three/examples/jsm/libs/basis/basis_transcoder.js',
    'three/examples/jsm/libs/basis/basis_transcoder.wasm',
    'three-mesh-bvh/src/index.js',
    '@recast-navigation/core/dist/index.mjs',
    '@recast-navigation/generators/dist/index.mjs',
    '@recast-navigation/three/dist/index.mjs',
    '@recast-navigation/wasm/dist/recast-navigation.wasm-compat.js',
    '@recast-navigation/wasm/dist/recast-navigation.wasm.wasm',
  ];
  for (const relative of entryPoints) nonEmptyFile(join(VENDOR, relative));
});

test('vendored versions match package.json', () => {
  const manifestPath = join(VENDOR, 'manifest.json');
  nonEmptyFile(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const declared = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies;
  for (const [name, info] of Object.entries(manifest.versions)) {
    if (!declared[name]) continue;
    assert.equal(
      info.installed,
      declared[name].replace(/^[\^~=v]+/, ''),
      `vendored ${name}@${info.installed} disagrees with package.json ${declared[name]}`,
    );
  }
});

test('importmap points at no remote host', () => {
  const { raw, imports } = importmap();
  assert.ok(!/https?:\/\//.test(raw), `importmap still references a remote host:\n${raw}`);
  for (const [specifier, target] of Object.entries(imports)) {
    assert.ok(target.startsWith('./vendor/'), `${specifier} does not resolve into ./vendor/ (got ${target})`);
  }
});

test('every importmap target exists on disk', () => {
  const { imports } = importmap();
  for (const [specifier, target] of Object.entries(imports)) {
    const path = resolve(WEB, target);
    if (specifier.endsWith('/')) {
      // Prefix keys map to a directory; the trailing slash is load-bearing.
      assert.ok(target.endsWith('/'), `prefix key ${specifier} lost its trailing slash`);
      assert.ok(existsSync(path) && statSync(path).isDirectory(), `${specifier} -> ${target} is not a directory`);
    } else {
      nonEmptyFile(path);
    }
  }
});

test('index.html loads nothing from a CDN', () => {
  // setTranscoderPath() and friends live outside the importmap, so scan the
  // whole document rather than trusting the importmap check alone.
  const remote = [...html.matchAll(/https?:\/\/[^\s'"`)]+/g)]
    .map((match) => match[0])
    .filter((url) => !/^https?:\/\/(www\.)?(schema\.org|www\.w3\.org|ogp\.me|creativecommons\.org)/.test(url))
    .filter((url) => /cdn|unpkg|jsdelivr|esm\.sh|skypack|googleapis/.test(url));
  assert.deepEqual(remote, [], `index.html still fetches from a CDN: ${remote.join(', ')}`);
});

test('every three/addons import in export/web is vendored', () => {
  // The vendor script prunes the 8.5 MB addons tree to the reachable closure;
  // this catches a new addon import that landed without a re-run.
  const sources = [INDEX, ...['enemy-system.js', 'viewmodel.js', 'player-controller.js', 'graphics-renderer.js'].map((f) => join(WEB, f))];
  const specifiers = new Set();
  for (const file of sources) {
    for (const match of readFileSync(file, 'utf8').matchAll(/['"]three\/addons\/([^'"]+)['"]/g)) specifiers.add(match[1]);
  }
  assert.ok(specifiers.size > 0, 'found no three/addons imports — the scanner regexp is broken');
  for (const specifier of specifiers) nonEmptyFile(join(VENDOR, 'three/examples/jsm', specifier));
});
