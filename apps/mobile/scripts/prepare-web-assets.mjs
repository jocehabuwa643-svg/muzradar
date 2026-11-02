import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../../node_modules/@mediapipe/tasks-vision/wasm/', import.meta.url));
const target = fileURLToPath(new URL('../public/wasm/', import.meta.url));
const model = fileURLToPath(new URL('../public/models/face_landmarker.task', import.meta.url));
const bundle = fileURLToPath(new URL('../../../node_modules/@mediapipe/tasks-vision/vision_bundle.js', import.meta.url));
const vendor = fileURLToPath(new URL('../public/vendor/', import.meta.url));

if (!existsSync(model)) throw new Error('Missing public/models/face_landmarker.task');
mkdirSync(target, { recursive: true });
mkdirSync(vendor, { recursive: true });
cpSync(source, target, { recursive: true });
cpSync(bundle, new URL('../public/vendor/vision_bundle.js', import.meta.url));
console.log('MediaPipe browser bundle, WASM and face model are ready in public/.');
