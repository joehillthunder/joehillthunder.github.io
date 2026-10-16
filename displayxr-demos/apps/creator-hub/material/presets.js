// Starter materials. Each is a layer stack (bottom first) plus material settings.
import { makeLayer } from './gen.js';

export const PRESETS = {
  'Rusted Steel': () => ({
    settings: { normal: 1.2, ao: 1 },
    layers: [
      makeLayer('noise', { name: 'Steel', colorA: '#8a8f96', colorB: '#a9aeb5', roughA: 0.28, roughB: 0.42, metalA: 1, metalB: 1, height: 0.05, p: { scale: 6, detail: 6 } }),
      makeLayer('scratches', { name: 'Scratches', colorA: '#c7ccd3', colorB: '#e3e7ec', roughA: 0.2, roughB: 0.15, metalA: 1, metalB: 1, mask: 'self', cover: 0.7, edge: 0.15, height: -0.15, p: { density: 0.6, length: 0.12 } }),
      makeLayer('grunge', { name: 'Rust', colorA: '#5a2a14', colorB: '#b5531f', roughA: 0.95, roughB: 0.8, metalA: 0, metalB: 0, height: 0.35, mask: 'noise', cover: 0.45, edge: 0.06, maskScale: 3, vary: 0.2, seed: 4, p: { scale: 5, detail: 7 } }),
    ],
  }),
  'Red Brick': () => ({
    settings: { normal: 1.6, ao: 1.4 },
    layers: [
      makeLayer('noise', { name: 'Mortar', colorA: '#8d8578', colorB: '#a9a294', roughA: 0.95, roughB: 0.9, p: { scale: 16, detail: 4 } }),
      makeLayer('bricks', { name: 'Bricks', colorA: '#7a2f1f', colorB: '#a8462c', roughA: 0.85, roughB: 0.75, height: 1, heightMode: 'max', mask: 'self', cover: 0.99, edge: 0.02, vary: 0.45, p: { scale: 10, ratio: 2.4, mortar: 0.1, bevel: 0.15 } }),
      makeLayer('grunge', { name: 'Grime', colorA: '#2d2620', colorB: '#4a3d33', blend: 'multiply', opacity: 0.55, roughA: 1, roughB: 0.95, mask: 'cavity', cover: 0.55, edge: 0.15, ch: { color: true, rough: true, metal: false, height: false } }),
      makeLayer('noise', { name: 'Surface pits', colorA: '#000000', colorB: '#ffffff', height: 0.12, ch: { color: false, rough: false, metal: false, height: true }, p: { scale: 24, detail: 5 } }),
    ],
  }),
  'Oak Planks': () => ({
    settings: { normal: 1, ao: 1 },
    layers: [
      makeLayer('wood', { name: 'Oak grain', colorA: '#9b6b3e', colorB: '#5e3a1d', roughA: 0.6, roughB: 0.5, height: 0.15, p: { scale: 14, warp: 1.2, grain: 0.5 } }),
      makeLayer('tiles', { name: 'Plank seams', colorA: '#2a1a0d', colorB: '#ffffff', blend: 'multiply', roughA: 0.8, roughB: 0.5, height: 0.6, vary: 0.35, ch: { color: true, rough: false, metal: false, height: true }, p: { scale: 6, ratio: 6, mortar: 0.04, bevel: 0.05 } }),
    ],
  }),
  'Carrara Marble': () => ({
    settings: { normal: 0.3, ao: 0.4, clearcoat: 0.6 },
    layers: [
      makeLayer('noise', { name: 'Base', colorA: '#e7e5e1', colorB: '#f4f3f0', roughA: 0.18, roughB: 0.12, p: { scale: 3, detail: 6 } }),
      makeLayer('marble', { name: 'Veins', colorA: '#f0efec', colorB: '#6f7378', roughA: 0.15, roughB: 0.2, mask: 'self', cover: 0.5, edge: 0.5, height: -0.08, p: { scale: 2, warp: 2.4, sharp: 7 } }),
    ],
  }),
  'Carbon Fiber': () => ({
    settings: { normal: 0.8, ao: 0.6, clearcoat: 1 },
    layers: [
      makeLayer('weave', { name: 'Twill weave', colorA: '#0d0e10', colorB: '#3a3d44', roughA: 0.45, roughB: 0.3, metalA: 0.3, metalB: 0.5, height: 0.25, p: { scale: 40 } }),
    ],
  }),
  'Sci-Fi Panel': () => ({
    settings: { normal: 1.4, ao: 1.2 },
    layers: [
      makeLayer('tiles', { name: 'Panels', colorA: '#1b1e23', colorB: '#6d747e', roughA: 0.6, roughB: 0.4, metalA: 0.8, metalB: 0.9, height: 0.8, vary: 0.25, p: { scale: 3, ratio: 0.5, mortar: 0.03, bevel: 0.04 } }),
      makeLayer('dots', { name: 'Rivets', colorA: '#9aa1ab', colorB: '#c9ced6', roughA: 0.3, roughB: 0.25, metalA: 1, metalB: 1, height: 0.25, heightMode: 'add', mask: 'self', cover: 0.85, edge: 0.05, p: { scale: 24, radius: 0.12 } }),
      makeLayer('crackle', { name: 'Light strips', colorA: '#24d3ff', colorB: '#24d3ff', emissive: 3, mask: 'self', cover: 0.04, edge: 0.01, maskInvert: false, invert: true, ch: { color: true, rough: true, metal: true, height: false }, roughA: 0.2, roughB: 0.2, p: { scale: 3, width: 0.02, warp: 0 } }),
      makeLayer('noise', { name: 'Edge wear', colorA: '#c8cdd4', colorB: '#e8ebef', roughA: 0.25, roughB: 0.2, metalA: 1, metalB: 1, mask: 'peaks', cover: 0.18, edge: 0.08, p: { scale: 12 } }),
    ],
  }),
  'Lava Rock': () => ({
    settings: { normal: 1.8, ao: 1.4 },
    layers: [
      makeLayer('crackle', { name: 'Glow', colorA: '#ff4a0a', colorB: '#ffb238', emissive: 4, roughA: 0.6, roughB: 0.6, p: { scale: 5, width: 0.2, warp: 0.8 } }),
      makeLayer('crackle', { name: 'Basalt', colorA: '#1a1614', colorB: '#3b3330', roughA: 0.9, roughB: 0.75, height: 1, heightMode: 'replace', mask: 'self', cover: 0.85, edge: 0.04, vary: 0.4, p: { scale: 5, width: 0.2, warp: 0.8 } }),
      makeLayer('noise', { name: 'Pores', colorA: '#000000', colorB: '#ffffff', height: 0.15, ch: { color: false, rough: false, metal: false, height: true }, p: { scale: 20, detail: 4 } }),
    ],
  }),
  'Leather': () => ({
    settings: { normal: 0.9, ao: 0.8 },
    layers: [
      makeLayer('cells', { name: 'Grain', colorA: '#5b3420', colorB: '#3a2014', roughA: 0.55, roughB: 0.7, height: 0.35, vary: 0.15, p: { scale: 40, jitter: 1 } }),
      makeLayer('noise', { name: 'Tone', colorA: '#6d4029', colorB: '#3c2416', blend: 'overlay', opacity: 0.6, ch: { color: true, rough: false, metal: false, height: false }, p: { scale: 3, detail: 4 } }),
    ],
  }),
  'Brushed Gold': () => ({
    settings: { normal: 0.5, ao: 0.3 },
    layers: [
      makeLayer('noise', { name: 'Gold', colorA: '#c99a3d', colorB: '#e2bd63', roughA: 0.3, roughB: 0.22, metalA: 1, metalB: 1, p: { scale: 4 } }),
      makeLayer('scratches', { name: 'Brushing', colorA: '#d9ad4c', colorB: '#f2cf78', roughA: 0.3, roughB: 0.18, metalA: 1, metalB: 1, height: -0.05, mask: 'self', cover: 0.9, edge: 0.3, p: { density: 1, length: 1, angle: 0, spread: 0.02 } }),
    ],
  }),
  'Mossy Stone': () => ({
    settings: { normal: 1.6, ao: 1.5 },
    layers: [
      makeLayer('cells', { name: 'Stones', colorA: '#9c968a', colorB: '#5c5a55', roughA: 0.8, roughB: 0.9, height: 1, vary: 0.4, p: { scale: 6, jitter: 0.9, warp: 0.4 } }),
      makeLayer('crackle', { name: 'Gaps', colorA: '#2b2925', colorB: '#ffffff', blend: 'multiply', height: 0.8, heightMode: 'add', ch: { color: true, rough: false, metal: false, height: true }, p: { scale: 6, width: 0.15, warp: 0.4 } }),
      makeLayer('grunge', { name: 'Moss', colorA: '#2f4a1a', colorB: '#6c8a2c', roughA: 1, roughB: 0.9, height: 0.15, mask: 'cavity', cover: 0.5, edge: 0.12, p: { scale: 6 } }),
    ],
  }),
};
