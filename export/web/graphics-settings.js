const PRESETS = Object.freeze({
  auto: { ratio: 1.5, pixels: 1440000, anisotropy: 4 },
  performance: { ratio: 1, pixels: 900000, anisotropy: 2 },
  quality: { ratio: 2, pixels: 1800000, anisotropy: 8 },
});
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const positive = (n, fallback) => Number.isFinite(n) && n > 0 ? n : fallback;

// Resolution follows sustained frame intervals, including GPU work between
// animation frames. It never uses the simulation's deliberately clamped dt.
export class GraphicsSettings {
  constructor({ mobile = false, preset = 'auto' } = {}) {
    this.mobile = mobile;
    this.preset = Object.hasOwn(PRESETS, preset) ? preset : 'auto';
    this.autoRatio = PRESETS.auto.ratio;
    this.width = this.height = this.dpr = 1;
    this.maxSize = 16384;
    this.resetTiming();
  }

  setPreset(preset) {
    if (!Object.hasOwn(PRESETS, preset)) return false;
    this.preset = preset;
    this.autoRatio = PRESETS.auto.ratio;
    this.resetTiming();
    return true;
  }

  setViewport(width, height, dpr, maxSize = 16384) {
    this.width = positive(width, 1);
    this.height = positive(height, 1);
    this.dpr = positive(dpr, 1);
    this.maxSize = positive(maxSize, 16384);
    // Preserve a learned scale through rotation, but discard its timing window.
    this.resetTiming();
  }

  get pixelRatio() {
    const preset = PRESETS[this.preset];
    const desired = this.mobile ? (this.preset === 'auto' ? this.autoRatio : preset.ratio) : 1;
    const budget = this.mobile ? preset.pixels : 1440000;
    return Math.min(desired, this.dpr, Math.sqrt(budget / (this.width * this.height)),
      this.maxSize / this.width, this.maxSize / this.height);
  }

  get antialias() { return this.mobile && this.preset !== 'performance'; }
  get anisotropy() { return this.mobile ? PRESETS[this.preset].anisotropy : 1; }

  resetTiming() {
    this.previous = null;
    this.warmup = 1000;
    this.elapsed = this.frames = this.slowWindows = this.fastWindows = 0;
  }

  observeFrame(now, active) {
    if (!active || !this.mobile || this.preset !== 'auto' || !Number.isFinite(now)) {
      this.resetTiming();
      return false;
    }
    const previous = this.previous;
    this.previous = now;
    if (previous === null) return false;
    const dt = now - previous;
    // Hidden tabs, debugger stops, and loading stalls must not lower quality.
    if (dt <= 0 || dt > 1000) { this.resetTiming(); return false; }
    if (this.warmup > 0) { this.warmup -= dt; return false; }
    this.elapsed += dt;
    this.frames++;
    if (this.elapsed < 1000) return false;
    const average = this.elapsed / this.frames;
    this.elapsed = this.frames = 0;
    this.slowWindows = average > 22 ? this.slowWindows + 1 : 0;
    this.fastWindows = average < 17.5 ? this.fastWindows + 1 : 0;
    const before = this.pixelRatio;
    if (this.slowWindows >= 2) {
      // If a tablet's pixel budget already limits the scale, lower from its
      // effective resolution instead of spending steps above that ceiling.
      this.autoRatio = Math.max(0.75, Math.min(this.autoRatio, before) - 0.125);
      this.slowWindows = this.fastWindows = 0;
    } else if (this.fastWindows >= 6) {
      this.autoRatio = clamp(this.autoRatio + 0.125, 0.75, PRESETS.auto.ratio);
      this.slowWindows = this.fastWindows = 0;
    }
    return Math.abs(before - this.pixelRatio) > 0.001;
  }

  getState() {
    return { preset: this.preset, mobile: this.mobile, adaptive: this.mobile && this.preset === 'auto',
      pixelRatio: Number(this.pixelRatio.toFixed(3)), anisotropy: this.anisotropy };
  }
}

// Color and depth attachments must both support the requested sample count.
// Some GPUs offer four samples but not two for the half-float HDR target.
export function chooseSamples(colorSamples = [], depthSamples = []) {
  return [...colorSamples].filter(n => n >= 2 && n <= 4 && [...depthSamples].includes(n))
    .sort((a, b) => a - b)[0] ?? 0;
}

export function filterTextures(root, requested, maximum = 1) {
  const anisotropy = Math.max(1, Math.min(requested, maximum));
  const seen = new Set();
  root.traverse(object => {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'bumpMap']) {
        const texture = material[key];
        if (!texture?.isTexture || seen.has(texture)) continue;
        seen.add(texture);
        if (texture.anisotropy !== anisotropy) {
          texture.anisotropy = anisotropy;
          texture.needsUpdate = true;
        }
      }
    }
  });
  return seen.size;
}
