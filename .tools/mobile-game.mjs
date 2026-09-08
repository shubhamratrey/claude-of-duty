import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

// Exercise a cold visit, including a tap before the game modules finish loading.
// The full touch suite must not silently bypass this path with ?autostart=1.
export async function runMobileStartup(page, artifactRoot, url) {
  const checks = {};
  const observations = {};
  let mapRequests = 0;
  const countMap = request => { if (new URL(request.url()).pathname.endsWith('/hijacked_optimized.glb')) mapRequests++; };
  page.on('request', countMap);
  let releaseModule;
  let pendingModule;
  const moduleGate = new Promise(resolve => { releaseModule = resolve; });
  const delayModule = route => {
    pendingModule = moduleGate.then(() => route.continue());
    return pendingModule;
  };
  await page.route('**/touch-controls.js', delayModule);
  const check = (name, passed) => { checks[name] = Boolean(passed); assert.ok(passed, name); };
  const shot = async name => {
    observations[name] = await page.evaluate(() => ({
      screen: document.getElementById('blocker').dataset.screen,
      text: document.getElementById('blocker').innerText,
      state: globalThis.hijacked?.debug?.getState() ?? null,
    }));
    observations[name].mapRequests = mapRequests;
    await page.screenshot({ path: path.join(artifactRoot, `startup-${name}.png`) });
    await fs.writeFile(path.join(artifactRoot, 'startup-states.json'), JSON.stringify(observations, null, 2));
    return observations[name];
  };
  try {
    const response = await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
    assert.ok(response?.ok(), `Game returned HTTP ${response?.status()}`);
    await page.waitForFunction(() => globalThis.hijackedStartup instanceof Promise);
    const prompt = page.locator('#fe-load-game');
    await prompt.waitFor({ state: 'visible' });
    const welcome = await shot('welcome');
    check('startupPromptVisible', welcome.screen === 'welcome' && /tap.*load/i.test(welcome.text));
    check('startupWaitsForTouch', mapRequests === 0 && welcome.state === null && !welcome.text.includes('0%'));
    const bounds = await prompt.boundingBox();
    assert.ok(bounds && bounds.height >= 44, 'startup needs a finger-sized target');
    // Locator actions wait for the pending document load. This gesture must
    // happen while that load is deliberately held, as on a slow connection.
    await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    const loading = await shot('early-touch');
    check('earlyTouchStartsLoading', loading.screen === 'loading' && loading.state === null);
    // Touchstart, pointerdown and compatibility click must share one boot.
    await page.touchscreen.tap(400, 180);
    await shot('repeated-touch');
    releaseModule();
    await page.waitForFunction(() => globalThis.hijacked?.debug?.getState().ready, null, { timeout: 180000 });
    const loaded = await shot('ready');
    check('earlyTouchReachesTitle', loaded.state?.ready && loaded.screen === 'title');
    check('startupDownloadsMapOnce', mapRequests === 1);
    return checks;
  } finally {
    releaseModule();
    await pendingModule;
    await page.unroute('**/touch-controls.js', delayModule);
    page.off('request', countMap);
  }
}

// Chromium's input protocol sends trusted, simultaneous touch contacts through
// the browser's hit testing, pointer capture and gesture arbitration.
export async function runMobileTest(page, artifactRoot) {
  const checks = {};
  const states = {};
  const state = () => page.evaluate(() => globalThis.hijacked.debug.getState());
  const shot = async (name) => {
    process.stdout.write(`Mobile: ${name}\n`);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    states[name] = await state();
    await page.screenshot({ path: path.join(artifactRoot, `mobile-${name}.png`) });
    await fs.writeFile(path.join(artifactRoot, 'mobile-states.json'), JSON.stringify(states, null, 2));
    return states[name];
  };
  const check = (name, passed) => { checks[name] = Boolean(passed); assert.ok(passed, name); };
  const center = async (selector) => {
    const box = await page.locator(selector).boundingBox();
    assert.ok(box, `${selector} must be visible`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const tap = async (selector, name, settled = null) => {
    const bounds = await page.locator(selector).boundingBox();
    const size = page.viewportSize();
    if (bounds && (bounds.y < 0 || bounds.y + bounds.height > size.height)) {
      await page.locator(selector).scrollIntoViewIfNeeded();
      await shot(`${name}-scroll`);
    }
    const p = await center(selector);
    await page.touchscreen.tap(p.x, p.y);
    if (settled) await wait(settled);
    return shot(name);
  };
  const cdp = await page.context().newCDPSession(page);
  const points = new Map();
  const contact = async (type, id, position) => {
    if (type === 'touchEnd') {
      // Chromium ends the supplied contact IDs, rather than treating this
      // array as the remaining fingers (an empty array releases everything).
      await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [points.get(id)] });
      points.delete(id);
    } else {
      points.set(id, { id, ...position, radiusX: 8, radiusY: 8, force: 1 });
      await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [...points.values()] });
    }
  };
  const release = async () => {
    points.clear();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const wait = (predicate) => page.waitForFunction(predicate, null, { timeout: 45000 });
  const buttonsFit = async () => page.locator('#touch-controls button').evaluateAll(buttons =>
    buttons.every(button => {
      const r = button.getBoundingClientRect();
      return r.width >= 44 && r.height >= 44 && r.left >= 0 && r.top >= 0 &&
        r.right <= innerWidth && r.bottom <= innerHeight;
    }));

  await page.evaluate(() => globalThis.hijacked.debug.setActive(false));
  await shot('menu-landscape');
  const started = await tap('[data-action="resume"]', 'landscape');
  await wait(() => globalThis.hijacked.debug.getState().input.touch.enabled);
  check('touchStartsWithoutPointerLock', started.active && started.input.touch.mode &&
    await page.evaluate(() => document.pointerLockElement === null));
  check('landscapeTargetsFit', await buttonsFit());

  const origin = await center('.touch-stick');
  const beforeMove = await state();
  await contact('touchStart', 1, origin);
  await contact('touchMove', 1, { x: origin.x, y: origin.y - 28 });
  await wait(() => globalThis.hijacked.debug.getState().input.touch.forward > 0.3);
  const walking = await shot('walk');
  check('analogWalk', walking.input.touch.forward > 0.3 && walking.input.touch.forward < 0.8 && !walking.input.touch.sprint);
  check('touchMovesPlayer', Math.hypot(...walking.player.feet.map((v, i) => v - beforeMove.player.feet[i])) > 1);
  await contact('touchMove', 1, { x: origin.x, y: origin.y - 55 });
  const sprinting = await shot('sprint');
  check('pushToSprint', sprinting.input.touch.sprint);

  const look = { x: 460, y: 160 };
  await contact('touchStart', 2, look);
  await contact('touchMove', 2, { x: look.x + 50, y: look.y + 15 });
  const looking = await shot('move-and-look');
  check('simultaneousMoveAndLook', looking.input.touch.pointers === 2 &&
    Math.hypot(...looking.player.forward.map((v, i) => v - sprinting.player.forward[i])) > 0.1);
  await contact('touchEnd', 2);
  await shot('look-release');
  const fire = await center('[data-touch="fire"]');
  await contact('touchStart', 3, fire);
  await contact('touchMove', 3, { x: fire.x - 28, y: fire.y - 10 });
  await wait(() => globalThis.hijacked.debug.getState().weapon.fireCount > 0);
  const firing = await shot('move-and-fire');
  check('fireWhileMoving', firing.weapon.triggerHeld && firing.weapon.fireCount > 0 && firing.input.touch.forward > 0.9);
  check('firingCancelsSprint', !firing.input.touch.sprint);
  check('dragFireAims', Math.hypot(...firing.player.forward.map((v, i) => v - looking.player.forward[i])) > 0.05);
  await release();
  const released = await shot('released');
  check('releaseClearsMovementAndFire', released.input.touch.pointers === 0 &&
    released.input.touch.forward === 0 && !released.weapon.triggerHeld);

  // Screenshot encoding can keep the fire contact down long enough to empty
  // a magazine on a slow renderer. Start the independent action probes with
  // a fresh life, clear of that automatic reload and the movement-test wall.
  await page.evaluate((before) => {
    const debug = globalThis.hijacked.debug;
    debug.respawnPlayer();
    debug.teleportPlayer(before.player.feet);
    debug.lookAt(before.player.eye.map((v, i) => v + before.player.forward[i] * 1000));
  }, beforeMove);
  await shot('actions-setup');

  const aiming = await tap('[data-touch="aim"]', 'aim',
    () => globalThis.hijacked.debug.getState().weapon.aiming);
  check('tapAimTogglesOn', aiming.input.touch.aim && aiming.weapon.aiming);
  const unAiming = await tap('[data-touch="aim"]', 'hip',
    () => !globalThis.hijacked.debug.getState().weapon.aiming);
  check('tapAimTogglesOff', !unAiming.input.touch.aim && !unAiming.weapon.aiming);
  await tap('[data-touch="crouch"]', 'crouch');
  await wait(() => globalThis.hijacked.debug.getState().player.crouched);
  check('tapCrouch', (await state()).player.crouched);
  await tap('[data-touch="crouch"]', 'stand');
  await wait(() => !globalThis.hijacked.debug.getState().player.crouched);
  // Start from the same unobstructed deck for the jump and interruption probes.
  await page.evaluate((feet) => globalThis.hijacked.debug.teleportPlayer(feet), beforeMove.player.feet);
  await shot('jump-setup');
  await wait(() => globalThis.hijacked.debug.getState().player.grounded);
  const jump = await center('[data-touch="jump"]');
  await page.touchscreen.tap(jump.x, jump.y);
  await wait(() => globalThis.hijacked.debug.getState().player.velocity[1] > 0);
  const jumping = await shot('jump');
  check('quickTapJumps', jumping.player.feet[1] > beforeMove.player.feet[1] + 1);
  await page.evaluate(() => globalThis.hijacked.debug.setWeaponAmmo(12, 240));
  await shot('reload-setup');
  const reloading = await tap('[data-touch="reload"]', 'reload',
    () => globalThis.hijacked.debug.getState().weapon.reloading);
  check('tapReload', reloading.weapon.reloading);
  await wait(() => !globalThis.hijacked.debug.getState().weapon.reloading);
  const reloaded = await shot('reloaded');
  check('reloadCompletes', reloaded.weapon.magazine === reloaded.weapon.magazineSize);

  await contact('touchStart', 1, await center('.touch-stick'));
  await contact('touchStart', 2, await center('[data-touch="fire"]'));
  await shot('cancel-setup');
  points.clear();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  const cancelled = await shot('cancelled');
  check('cancelClearsContacts', cancelled.input.touch.pointers === 0 && !cancelled.weapon.triggerHeld);
  await tap('#touch-scores', 'scores');
  check('scoreboardReachable', await page.locator('#scoreboard').isVisible());
  await tap('#touch-score-close', 'scores-closed');
  check('scoreboardDismissible', !await page.locator('#scoreboard').isVisible());
  await contact('touchStart', 1, await center('.touch-stick'));
  await contact('touchStart', 2, await center('[data-touch="fire"]'));
  await shot('pause-setup');
  await contact('touchStart', 3, await center('#touch-pause'));
  await shot('pause-held-inputs');
  await release();
  await shot('pause');
  check('touchPause', !(await state()).active && !(await state()).input.touch.visible);
  // A slider gesture must not bubble into the shell's tap-to-resume action.
  await tap('#touch-sensitivity', 'sensitivity');
  check('settingsDoNotResume', !(await state()).active);
  await tap('[data-action="class"]:visible', 'classes-landscape');
  await tap('[data-weapon-id="an94"]', 'class-selected');
  await tap('[data-action="class-confirm"]', 'class-confirmed');
  check('touchClassSelection', (await state()).weapon.id === 'an94');
  await tap('[data-action="resume"]', 'resumed');
  await contact('touchStart', 1, await center('[data-touch="fire"]'));
  await shot('rotation-setup');
  await page.setViewportSize({ width: 390, height: 844 });
  await release();
  const portrait = await shot('portrait');
  check('rotationClearsFire', portrait.input.touch.pointers === 0 && !portrait.weapon.triggerHeld);
  check('portraitTargetsFit', await buttonsFit());
  const portraitPaused = await tap('#touch-pause', 'menu-portrait');
  check('singleFingerPauseAfterRotation', !portraitPaused.active && portraitPaused.menu.visible);
  await tap('[data-action="class"]:visible', 'classes-portrait');
  await page.locator('[data-action="class-back"]').scrollIntoViewIfNeeded();
  await shot('classes-portrait-scrolled');
  await tap('[data-action="class-back"]', 'class-back-portrait');
  await page.locator('[data-action="resume"]').scrollIntoViewIfNeeded();
  await tap('[data-action="resume"]', 'portrait-resumed');
  await page.evaluate(() => globalThis.hijacked.debug.respawnPlayer());
  await shot('death-setup');
  await contact('touchStart', 1, await center('[data-touch="fire"]'));
  await page.evaluate(() => globalThis.hijacked.debug.damagePlayer(1000));
  const dead = await shot('death');
  check('deathClearsTouch', dead.player.dead && !dead.input.touch.enabled && dead.input.touch.pointers === 0);
  await release();
  await wait(() => !globalThis.hijacked.debug.getState().player.dead);
  const respawned = await shot('respawned');
  check('respawnHasNoStuckTrigger', respawned.input.touch.enabled && !respawned.weapon.triggerHeld);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  const blurred = await shot('blur');
  check('interruptionPauses', !blurred.active && blurred.input.touch.pointers === 0);
  await tap('[data-action="resume"]', 'after-interruption');
  await page.evaluate(() => globalThis.hijacked.debug.finishMatch());
  await shot('match-ended');
  check('matchRestartReachable', await page.locator('#touch-restart').isVisible());
  const restarted = await tap('#touch-restart', 'match-restarted');
  check('touchRestartsMatch', restarted.match.phase === 'playing' && restarted.active && restarted.player.enabled);
  for (const [name, size] of [
    ['small-phone', { width: 320, height: 568 }],
    ['tablet', { width: 1024, height: 768 }],
  ]) {
    await page.setViewportSize(size);
    await shot(name);
    check(`${name}TargetsFit`, await buttonsFit());
  }
  await page.setViewportSize({ width: 844, height: 390 });
  await shot('landscape-final');
  await page.evaluate(() => globalThis.hijacked.debug.pause());
  await shot('final');
  return { checks, states: Object.keys(states) };
}
