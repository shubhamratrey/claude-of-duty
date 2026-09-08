#!/usr/bin/env node
// Copies the browser's third-party ES modules out of node_modules into
// export/web/vendor/ so the game boots on a LAN with no internet uplink.
// Guests join over WiFi from phones and laptops; if the importmap points at a
// CDN then every guest hard-fails at boot on an air-gapped network.
//
// Run: npm run vendor
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, extname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE_MODULES = join(ROOT, 'node_modules');
const VENDOR = join(ROOT, 'export', 'web', 'vendor');
const WEB = join(ROOT, 'export', 'web');

// Packages whose vendored copy the game imports through the importmap. The
// installed version is cross-checked against package.json so a vendor run can
// never silently ship a build that disagrees with the lockfile.
const PACKAGES = ['three', 'three-mesh-bvh', '@recast-navigation/core', '@recast-navigation/generators', '@recast-navigation/three', '@recast-navigation/wasm'];

// Declaration files are never fetched by a browser, and draco is 1.8 MB of
// decoder we do not load (the map uses KHR_texture_basisu, not draco).
const SKIP_EXTENSIONS = new Set(['.ts']);

// KTX2Loader fetches basis_transcoder.{js,wasm} by URL at runtime via
// setTranscoderPath(), so static import analysis cannot see them. The map's
// glTF lists KHR_texture_basisu in extensionsRequired, so these must ship.
const ADDON_RUNTIME_DIRS = ['libs/basis'];

function fail(message) {
  throw new Error(`vendor_deps: ${message}`);
}

function readJson(path) {
  if (!existsSync(path)) fail(`missing ${relative(ROOT, path)}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function requirePath(path, why) {
  if (!existsSync(path)) fail(`missing ${relative(ROOT, path)} (${why}) — run \`npm install\` first`);
  return path;
}

// Version ranges in package.json carry a ^ or ~ prefix; the vendored bytes are
// whatever npm actually installed, so compare against that and report both.
function resolveVersions() {
  const declared = readJson(join(ROOT, 'package.json')).dependencies ?? {};
  const versions = {};
  for (const name of PACKAGES) {
    const pkgJson = readJson(join(requirePath(join(NODE_MODULES, name), `${name} dependency`), 'package.json'));
    const range = declared[name];
    if (range) {
      const pinned = range.replace(/^[\^~=v]+/, '');
      // An exact pin that no longer matches the install means node_modules is
      // stale; vendoring it would ship a version the importmap never promised.
      if (!/^[\^~]/.test(range) && pinned !== pkgJson.version) {
        fail(`${name} is pinned to ${pinned} in package.json but ${pkgJson.version} is installed`);
      }
    }
    versions[name] = { installed: pkgJson.version, declared: range ?? '(transitive)' };
  }
  return versions;
}

function listFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

const copied = [];

function copyOne(src, dest) {
  requirePath(src, 'vendor source');
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  copied.push(dest);
}

function copyTree(srcDir, destDir, { skipExtensions = SKIP_EXTENSIONS } = {}) {
  requirePath(srcDir, 'vendor source tree');
  for (const src of listFiles(srcDir)) {
    if (skipExtensions.has(extname(src))) continue;
    copyOne(src, join(destDir, relative(srcDir, src)));
  }
}

// --- three/examples/jsm closure -------------------------------------------
// The full addons tree is 8.5 MB and 430 files, almost all of it loaders and
// postprocessing the game never touches. Rather than cherry-pick by hand
// (addons import each other relatively, so a hand-picked list rots), walk the
// real import graph from whatever the app actually imports.

const IMPORT_RE = /(?:^|[\s;{}(=])(?:import|export)\s*(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiersIn(source) {
  const found = new Set();
  for (const match of source.matchAll(IMPORT_RE)) found.add(match[1] ?? match[2]);
  return found;
}

// Entry points are discovered by scanning rather than hand-listed, so adding a
// new addon import to the game only needs a re-run. The vendored dependencies
// are scanned too: @recast-navigation/three's debug drawer imports
// three/addons/lines/*, which a scan of our own source alone would miss.
function findAddonEntryPoints(scanDirs) {
  const entries = new Set();
  for (const dir of scanDirs) {
    for (const file of listFiles(dir)) {
      if (file.startsWith(join(VENDOR, 'three', 'examples'))) continue;
      if (!/\.(js|mjs|html)$/.test(file)) continue;
      for (const match of readFileSync(file, 'utf8').matchAll(/['"]three\/addons\/([^'"]+)['"]/g)) {
        entries.add(match[1]);
      }
    }
  }
  if (entries.size === 0) fail('found no `three/addons/...` imports — the entry-point scanner is broken');
  return [...entries].sort();
}

function addonClosure(jsmDir, entryPoints) {
  const reachable = new Set();
  const queue = [...entryPoints];
  while (queue.length > 0) {
    const rel = posix.normalize(queue.pop());
    if (reachable.has(rel)) continue;
    const abs = join(jsmDir, rel);
    requirePath(abs, `three/addons/${rel} imported by the game`);
    reachable.add(rel);
    for (const spec of specifiersIn(readFileSync(abs, 'utf8'))) {
      // Bare specifiers ('three', 'three/tsl') resolve through the importmap.
      if (spec.startsWith('three/addons/')) queue.push(spec.slice('three/addons/'.length));
      else if (spec.startsWith('.')) queue.push(posix.join(posix.dirname(rel), spec));
    }
  }
  return reachable;
}

// --- run -------------------------------------------------------------------

const versions = resolveVersions();

// A full wipe keeps the run idempotent and prunes files that a previous run
// vendored but nothing imports any more.
rmSync(VENDOR, { recursive: true, force: true });
mkdirSync(VENDOR, { recursive: true });

// three: the module build plus the core chunk it imports relatively.
copyOne(join(NODE_MODULES, 'three/build/three.module.js'), join(VENDOR, 'three/build/three.module.js'));
copyOne(join(NODE_MODULES, 'three/build/three.core.js'), join(VENDOR, 'three/build/three.core.js'));
copyOne(join(NODE_MODULES, 'three/LICENSE'), join(VENDOR, 'three/LICENSE'));

// three-mesh-bvh ships as unbundled source; the importmap points at src/index.js.
copyTree(join(NODE_MODULES, 'three-mesh-bvh/src'), join(VENDOR, 'three-mesh-bvh/src'));
copyOne(join(NODE_MODULES, 'three-mesh-bvh/LICENSE'), join(VENDOR, 'three-mesh-bvh/LICENSE'));

// recast-navigation. The wasm-compat build base64-embeds the binary, but the
// plain build fetches recast-navigation.wasm.wasm next to itself, so ship the
// whole dist rather than betting on which one gets loaded.
for (const name of ['core', 'generators', 'three', 'wasm']) {
  copyTree(join(NODE_MODULES, `@recast-navigation/${name}/dist`), join(VENDOR, `@recast-navigation/${name}/dist`));
  const license = join(NODE_MODULES, `@recast-navigation/${name}/LICENSE`);
  if (existsSync(license)) copyOne(license, join(VENDOR, `@recast-navigation/${name}/LICENSE`));
}

// Addons come last: the entry-point scan reads the vendored dependencies above,
// which import three/addons/* of their own.
const jsmDir = requirePath(join(NODE_MODULES, 'three/examples/jsm'), 'three addons tree');
const entryPoints = findAddonEntryPoints([WEB]);
const closure = addonClosure(jsmDir, entryPoints);
for (const rel of [...closure].sort()) {
  copyOne(join(jsmDir, rel), join(VENDOR, 'three/examples/jsm', rel));
}
for (const dir of ADDON_RUNTIME_DIRS) {
  copyTree(join(jsmDir, dir), join(VENDOR, 'three/examples/jsm', dir));
}

const totalBytes = copied.reduce((sum, path) => sum + statSync(path).size, 0);
const manifest = {
  generatedBy: '.tools/vendor_deps.mjs',
  versions,
  threeAddons: { entryPoints, closureFiles: closure.size, runtimeDirs: ADDON_RUNTIME_DIRS },
  files: copied.length,
  bytes: totalBytes,
  // Lets the test (and a reviewer) spot a hand-edited vendor tree.
  digest: createHash('sha256').update(copied.map((p) => `${relative(VENDOR, p)}:${statSync(p).size}`).sort().join('\n')).digest('hex').slice(0, 16),
};
writeFileSync(join(VENDOR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`vendored ${manifest.files} files (${(totalBytes / 1024 / 1024).toFixed(2)} MB) into ${relative(ROOT, VENDOR)}`);
console.log(`three/addons closure: ${closure.size} files from ${entryPoints.length} entry points`);
for (const [name, info] of Object.entries(versions)) console.log(`  ${name}@${info.installed} (package.json: ${info.declared})`);
