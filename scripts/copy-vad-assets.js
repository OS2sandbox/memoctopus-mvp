#!/usr/bin/env node
// Copies @ricky0123/vad-web static assets (worklet, ONNX model, WASM runtime)
// into public/ so Next.js can serve them at the root path.
const { copyFileSync, mkdirSync, existsSync } = require('fs');
const { resolve } = require('path');

const root = resolve(__dirname, '..');
const pub = resolve(root, 'public');
mkdirSync(pub, { recursive: true });

const copies = [
  ['node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js', 'public/vad.worklet.bundle.min.js'],
  ['node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx', 'public/silero_vad_legacy.onnx'],
  ['node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx', 'public/silero_vad_v5.onnx'],
  // onnxruntime-web needs both the .mjs entry modules and the .wasm binaries
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', 'public/ort-wasm-simd-threaded.mjs'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'public/ort-wasm-simd-threaded.wasm'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs', 'public/ort-wasm-simd-threaded.jsep.mjs'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm', 'public/ort-wasm-simd-threaded.jsep.wasm'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs', 'public/ort-wasm-simd-threaded.asyncify.mjs'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm', 'public/ort-wasm-simd-threaded.asyncify.wasm'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jspi.mjs', 'public/ort-wasm-simd-threaded.jspi.mjs'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jspi.wasm', 'public/ort-wasm-simd-threaded.jspi.wasm'],
];

let copied = 0;
for (const [src, dst] of copies) {
  const srcPath = resolve(root, src);
  const dstPath = resolve(root, dst);
  if (existsSync(srcPath)) {
    copyFileSync(srcPath, dstPath);
    copied++;
  } else {
    console.warn('[copy-vad-assets] skipped (not found):', src);
  }
}
console.log(`[copy-vad-assets] copied ${copied}/${copies.length} files to public/`);
