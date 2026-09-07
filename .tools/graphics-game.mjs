import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function runGraphicsTest(page, artifactRoot, fallback = false) {
  const states = {}, checks = {};
  const check = (name, passed) => { checks[name] = Boolean(passed); assert.ok(passed, name); };
  const shot = async name => {
    process.stdout.write(`Graphics: ${name}\n`);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    states[name] = await page.evaluate(() => globalThis.hijacked.debug.getState());
    await page.screenshot({ path: path.join(artifactRoot, `graphics-${name}.png`) });
    await fs.writeFile(path.join(artifactRoot, 'graphics-states.json'), JSON.stringify(states, null, 2));
    return states[name];
  };
  const auto = await shot('auto');
  check('autoSharperThanCssResolution', auto.performance.pixelRatio === 1.5);
  check('antialiasesScene', ['msaa', 'fxaa'].includes(auto.performance.graphics.antialiasing));
  if (fallback) check('fxaaFallback', auto.performance.graphics.antialiasing === 'fxaa');
  check('filtersWorldAndWeapon', auto.performance.graphics.filteredTextures > 20 && auto.performance.graphics.anisotropy > 1);
  await page.evaluate(() => globalThis.hijacked.debug.setGraphicsPreset('performance'));
  await shot('performance');
  await page.evaluate(() => globalThis.hijacked.debug.setGraphicsPreset('auto'));
  await page.evaluate(() => globalThis.hijacked.debug.showMenu(true));
  await shot('menu');
  for (const preset of ['performance', 'quality', 'auto', 'performance', 'quality']) {
    await page.locator('#touch-graphics').selectOption(preset);
    const state = await shot(`${preset}-${Object.keys(states).length}`);
    check(`${preset}PresetApplies`, state.performance.graphics.preset === preset && state.menu.visible);
    check(`${preset}BuffersMatch`, JSON.stringify(state.performance.drawingBuffer) === JSON.stringify(state.performance.graphics.sceneBuffer));
    check(`${preset}Persists`, await page.evaluate(p => localStorage.getItem('hijacked.graphics') === p, preset));
    if (preset === 'performance') check('performanceDisablesAa', state.performance.graphics.antialiasing === 'off' && state.performance.pixelRatio === 1);
    if (preset === 'quality') check('qualitySharper', state.performance.pixelRatio === 2);
  }
  await page.evaluate(() => globalThis.hijacked.debug.showMenu(false));
  await shot('quality');
  await page.setViewportSize({ width: 390, height: 844 });
  const portrait = await shot('portrait');
  check('portraitBufferResizes', portrait.performance.drawingBuffer[0] === 780 && portrait.performance.drawingBuffer[1] === 1688);
  await page.setViewportSize({ width: 2048, height: 1536 });
  const tablet = await shot('tablet');
  check('tabletPixelBudget', tablet.performance.drawingBuffer[0] * tablet.performance.drawingBuffer[1] <= 1800000);
  await page.setViewportSize({ width: 844, height: 390 });
  await shot('landscape');
  await page.evaluate(() => {
    const api = globalThis.hijacked.debug;
    api.setGraphicsPreset('performance'); api.respawnPlayer(); api.resume();
  });
  await shot('input-setup');
  await page.waitForFunction(() => globalThis.hijacked.debug.getState().input.touch.enabled);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: 110, y: 310 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: 110, y: 285 }] });
  const held = await shot('held-movement');
  await page.evaluate(() => globalThis.hijacked.debug.setGraphicsPreset('quality'));
  const changed = await shot('quality-while-moving');
  check('resolutionPreservesTouch', changed.input.touch.pointers === 1 && changed.input.touch.forward === held.input.touch.forward && held.input.touch.forward > 0);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await shot('released');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.hijacked?.debug?.getState().ready, null, { timeout: 180000 });
  const reloaded = await shot('reloaded');
  check('presetSurvivesReload', reloaded.performance.graphics.preset === 'quality' && await page.locator('#touch-graphics').inputValue() === 'quality');
  return { checks, states: Object.keys(states) };
}
