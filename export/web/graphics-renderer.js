import * as THREE from 'three';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { chooseSamples } from './graphics-settings.js';

// Smooth the actual scene target; canvas antialiasing would only smooth the
// fullscreen grading quad. FXAA handles GPUs without multisampled HDR buffers.
export class GraphicsRenderer {
  constructor(renderer) {
    this.renderer = renderer;
    const gl = renderer.getContext();
    this.samples = chooseSamples(
      gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES) ?? [],
      gl.getInternalformatParameter(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, gl.SAMPLES) ?? [],
    );
    this.mode = 'off';
    this.filteredTextures = 0;
    this.target = null;
    this.material = null;
    this.scene = null;
  }

  configure(enabled, sceneTarget) {
    this.mode = enabled ? (this.samples ? 'msaa' : 'fxaa') : 'off';
    const samples = this.mode === 'msaa' ? this.samples : 0;
    if (sceneTarget.samples !== samples) {
      sceneTarget.dispose();
      sceneTarget.samples = samples;
    }
    sceneTarget.resolveDepthBuffer = false;
    if (this.mode === 'fxaa' && !this.target) {
      // The grading shader already encodes sRGB. Keep these display-referred
      // bytes unchanged through FXAA, avoiding a second tone/colour conversion.
      this.target = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
      this.material = new THREE.ShaderMaterial({ ...FXAAShader,
        uniforms: THREE.UniformsUtils.clone(FXAAShader.uniforms), depthTest: false, depthWrite: false });
      this.scene = new THREE.Scene();
      this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
    } else if (this.mode !== 'fxaa' && this.target) {
      this.target.dispose();
      this.material.dispose();
      this.scene.children[0].geometry.dispose();
      this.target = this.material = this.scene = null;
    }
    this.setSize(sceneTarget.width, sceneTarget.height);
  }

  setSize(width, height) {
    this.target?.setSize(width, height);
    this.material?.uniforms.resolution.value.set(1 / width, 1 / height);
  }

  render(gradeScene, camera) {
    const renderer = this.renderer;
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(gradeScene, camera);
    if (this.target) {
      this.material.uniforms.tDiffuse.value = this.target.texture;
      renderer.setRenderTarget(null);
      renderer.clear();
      renderer.render(this.scene, camera);
    }
  }

  getState() {
    return { antialiasing: this.mode, samples: this.mode === 'msaa' ? this.samples : 0,
      supportedSamples: this.samples, filteredTextures: this.filteredTextures };
  }
}
