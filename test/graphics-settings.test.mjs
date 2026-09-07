import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { GraphicsSettings, chooseSamples, filterTextures } from '../export/web/graphics-settings.js';

test('mobile presets respect density, pixel budgets, and GPU size limits', () => {
  const settings = new GraphicsSettings({ mobile: true });
  settings.setViewport(844, 390, 3);
  assert.equal(settings.pixelRatio, 1.5);
  assert.equal(settings.antialias, true);
  settings.setPreset('quality');
  assert.equal(settings.pixelRatio, 2);
  settings.setViewport(2048, 1536, 3);
  assert.ok(2048 * 1536 * settings.pixelRatio ** 2 <= 1800001);
  settings.setViewport(844, 390, 3, 512);
  assert.ok(844 * settings.pixelRatio <= 512);
  settings.setViewport(390, 844, 1);
  assert.equal(settings.pixelRatio, 1);
  settings.setPreset('performance');
  assert.equal(settings.antialias, false);
});

test('desktop keeps its rendering budget and invalid saved presets use Auto', () => {
  const settings = new GraphicsSettings({ preset: 'broken' });
  settings.setViewport(1280, 720, 3);
  assert.equal(settings.preset, 'auto');
  assert.equal(settings.pixelRatio, 1);
  assert.equal(settings.antialias, false);
  assert.equal(settings.setPreset('__proto__'), false);
  settings.setViewport(3840, 2160, 3);
  assert.ok(3840 * 2160 * settings.pixelRatio ** 2 <= 1440001);
});

function frames(settings, count, dt, from = 0) {
  let time = from;
  for (let i = 0; i < count; i++) settings.observeFrame(time += dt, true);
  return time;
}

test('Auto backs off sustained slow frames and recovers cautiously', () => {
  const settings = new GraphicsSettings({ mobile: true });
  settings.setViewport(844, 390, 3);
  let time = frames(settings, 160, 33);
  assert.ok(settings.pixelRatio < 1.5 && settings.pixelRatio >= 0.75);
  const slow = settings.pixelRatio;
  time = frames(settings, 180, 16.67, time);
  assert.equal(settings.pixelRatio, slow, 'three fast seconds cannot immediately raise resolution');
  frames(settings, 900, 16.67, time);
  assert.ok(settings.pixelRatio > slow && settings.pixelRatio <= 1.5);
});

test('pause, long stalls, and manual presets cannot contaminate Auto timing', () => {
  const settings = new GraphicsSettings({ mobile: true });
  settings.setViewport(844, 390, 3);
  let time = frames(settings, 40, 33);
  settings.observeFrame(time += 5000, false);
  settings.observeFrame(time += 5000, true);
  settings.observeFrame(time += 5000, true);
  time = frames(settings, 80, 16.67, time);
  assert.equal(settings.pixelRatio, 1.5);
  settings.setPreset('quality');
  frames(settings, 300, 50, time);
  assert.equal(settings.pixelRatio, 2);
});

test('Auto lowers the effective tablet resolution and never exceeds its floor', () => {
  const settings = new GraphicsSettings({ mobile: true });
  settings.setViewport(1600, 900, 3);
  const start = settings.pixelRatio;
  frames(settings, 300, 50);
  assert.ok(settings.pixelRatio < start);
  assert.equal(settings.pixelRatio, 0.75);
  settings.setViewport(900, 1600, 3);
  assert.equal(settings.pixelRatio, 0.75, 'rotation preserves learned quality');
});

test('Auto can recover a severely overloaded phone instead of treating every frame as a pause', () => {
  const settings = new GraphicsSettings({ mobile: true });
  settings.setViewport(844, 390, 3);
  frames(settings, 40, 500);
  assert.equal(settings.pixelRatio, 0.75);
});

test('MSAA requires a sample count shared by HDR color and depth', () => {
  assert.equal(chooseSamples([8, 4, 2], [4, 2]), 2);
  assert.equal(chooseSamples(new Int32Array([4]), new Int32Array([4, 2])), 4);
  assert.equal(chooseSamples([4], [2]), 0);
  assert.equal(chooseSamples([], [4]), 0);
  assert.equal(chooseSamples([8], [8]), 0);
});

test('filtering updates shared surface textures once and leaves lookup textures alone', () => {
  const scene = new THREE.Scene();
  const map = new THREE.Texture(), normalMap = new THREE.Texture(), envMap = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map, normalMap, envMap });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), material), new THREE.Mesh(new THREE.PlaneGeometry(), material));
  assert.equal(filterTextures(scene, 8, 4), 2);
  assert.equal(map.anisotropy, 4);
  assert.equal(normalMap.anisotropy, 4);
  assert.equal(envMap.anisotropy, 1);
  const version = map.version;
  filterTextures(scene, 8, 4);
  assert.equal(map.version, version, 'unchanged filtering must not re-upload textures');
  filterTextures(scene, 2, 4);
  assert.equal(map.anisotropy, 2);
  assert.equal(map.version, version + 1);
});
