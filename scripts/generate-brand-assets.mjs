// Generates every brand asset from the owner-supplied artwork. Dev-only: the generated files are
// committed, so a build never depends on running this. Run: npm run brand:assets
//
// Input:  assets/brand/framecapt-logo-source.png (owner artwork, unchanged; its alpha channel has a
//         blotchy dark halo that is rebuilt below).
// Output: assets/brand/framecapt-logo{,-512,-256}.png      transparent masters
//         assets/app/framecapt.ico                          app/installer icon (16..256 px)
//         assets/app/install-loading.gif                    Squirrel.Windows loadingGif
//         assets/tray/tray-{16,20,24,32}.png, tray-recording-*.png, framecapt.ico (tray preview set)
//         src/main/tray-icons.generated.ts                  the tray PNGs as base64 (nothing extra to ship)
//         src/renderer/assets/logo-{32,64,128,256}.png      UI logo, imported through Vite
//
// Deterministic: no randomness, no clock, no fonts; running it twice gives identical bytes.
// Tooling: @napi-rs/canvas (MIT) decodes/encodes PNG and GIF; it is a devDependency and not shipped.
// The artwork is owner-supplied brand artwork (c) Ashiqur Rahman Emran, see docs/licensing.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage, GifEncoder } from '@napi-rs/canvas';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...parts) => path.join(root, ...parts);
const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};

const BRIGHT_THRESHOLD = 60; // a pixel brighter than this is part of the artwork (not halo)
const CLOSE_RADIUS = 14; // morphological closing radius that fills gaps inside the silhouette
const MARGIN = 1.08; // square padding around the cropped silhouette
const MASTER = 1024;
const TRAY_SIZES = [16, 20, 24, 32]; // 100, 125, 150 and 200 % display scaling
const TRAY_SCALES = { 16: 1, 20: 1.25, 24: 1.5, 32: 2 };
const APP_ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const UI_SIZES = [32, 64, 128, 256];

// --- clean master -------------------------------------------------------------------------------

/** Separable square dilate (any set pixel in the window) or erode (all set), via prefix sums. */
function morph(src, w, h, radius, dilate) {
  const pass = (input, length, lines, stride, step) => {
    const out = new Uint8Array(input.length);
    const prefix = new Int32Array(length + 1);
    for (let line = 0; line < lines; line++) {
      const base = line * stride;
      for (let i = 0; i < length; i++) prefix[i + 1] = prefix[i] + input[base + i * step];
      for (let i = 0; i < length; i++) {
        const lo = Math.max(0, i - radius);
        const hi = Math.min(length - 1, i + radius);
        const count = prefix[hi + 1] - prefix[lo];
        // Outside the image counts as empty: erosion eats in from the border like the prototype.
        out[base + i * step] = dilate ? (count > 0 ? 1 : 0) : count === 2 * radius + 1 ? 1 : 0;
      }
    }
    return out;
  };
  return pass(pass(src, w, h, w, 1), h, w, 1, w);
}

function boxBlur3(mask, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && xx < w && yy >= 0 && yy < h) {
            sum += mask[yy * w + xx];
            n++;
          }
        }
      }
      out[y * w + x] = sum / n;
    }
  }
  return out;
}

/** Rebuilds the alpha from a silhouette mask, crops to it and pads to a square. */
async function cleanLogo() {
  const image = await loadImage(
    fs.readFileSync(at('assets', 'brand', 'framecapt-logo-source.png')),
  );
  const w = image.width;
  const h = image.height;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;

  const shape = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const brightest = Math.max(px[4 * i], px[4 * i + 1], px[4 * i + 2]);
    if (px[4 * i + 3] > 128 && brightest > BRIGHT_THRESHOLD) shape[i] = 1;
  }
  const dilated = morph(shape, w, h, CLOSE_RADIUS, true);

  // Background = what the border can reach without crossing the dilated silhouette.
  const background = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const i = stack.pop();
    if (background[i] || dilated[i]) continue;
    background[i] = 1;
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  const filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) filled[i] = background[i] ? 0 : 1;
  const soft = boxBlur3(boxBlur3(morph(filled, w, h, CLOSE_RADIUS, false), w, h), w, h);

  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  for (let i = 0; i < w * h; i++) {
    const a = Math.round(soft[i] * 255);
    px[4 * i + 3] = Math.min(px[4 * i + 3], a);
    if (a > 0) {
      const x = i % w;
      const y = (i / w) | 0;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  ctx.putImageData(data, 0, 0);

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const side = Math.round(Math.max(bw, bh) * MARGIN);
  const square = createCanvas(side, side);
  square
    .getContext('2d')
    .drawImage(
      canvas,
      minX,
      minY,
      bw,
      bh,
      Math.round((side - bw) / 2),
      Math.round((side - bh) / 2),
      bw,
      bh,
    );
  return square;
}

// --- resampling ---------------------------------------------------------------------------------

function lanczos(x) {
  if (x === 0) return 1;
  if (Math.abs(x) >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
}

/** Lanczos-3 resize of premultiplied RGBA floats; returns straight RGBA bytes. */
function resize(source, size) {
  const { width: sw, data } = source;
  const scale = sw / size;
  const support = Math.max(1, scale) * 3;
  const weights = [];
  for (let o = 0; o < size; o++) {
    const center = (o + 0.5) * scale;
    const first = Math.max(0, Math.floor(center - support));
    const last = Math.min(sw - 1, Math.ceil(center + support));
    const list = [];
    let total = 0;
    for (let i = first; i <= last; i++) {
      const weight = lanczos((i + 0.5 - center) / Math.max(1, scale));
      list.push([i, weight]);
      total += weight;
    }
    weights.push(list.map(([i, weight]) => [i, weight / total]));
  }
  const pre = new Float32Array(sw * sw * 4);
  for (let i = 0; i < sw * sw; i++) {
    const a = data[4 * i + 3] / 255;
    pre[4 * i] = data[4 * i] * a;
    pre[4 * i + 1] = data[4 * i + 1] * a;
    pre[4 * i + 2] = data[4 * i + 2] * a;
    pre[4 * i + 3] = data[4 * i + 3];
  }
  const horizontal = new Float32Array(size * sw * 4);
  for (let y = 0; y < sw; y++) {
    for (let x = 0; x < size; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (const [i, weight] of weights[x]) sum += pre[(y * sw + i) * 4 + c] * weight;
        horizontal[(y * size + x) * 4 + c] = sum;
      }
    }
  }
  const out = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (const [i, weight] of weights[y]) sum += horizontal[(i * size + x) * 4 + c] * weight;
        out[(y * size + x) * 4 + c] = sum;
      }
    }
  }
  return out;
}

/** Light unsharp mask on premultiplied floats (3x3 binomial blur), for icons of 32 px and less. */
function sharpen(buffer, size, amount) {
  const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  const out = new Float32Array(buffer.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++, k++) {
            const xx = Math.min(size - 1, Math.max(0, x + dx));
            const yy = Math.min(size - 1, Math.max(0, y + dy));
            sum += buffer[(yy * size + xx) * 4 + c] * kernel[k];
          }
        }
        const here = buffer[(y * size + x) * 4 + c];
        out[(y * size + x) * 4 + c] = here + amount * (here - sum / 16);
      }
    }
  }
  return out;
}

/** Premultiplied floats to a canvas holding straight-alpha RGBA. */
function toCanvas(buffer, size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const a = Math.min(255, Math.max(0, buffer[4 * i + 3]));
    for (let c = 0; c < 3; c++) {
      const v = a > 0 ? (buffer[4 * i + c] * 255) / a : 0;
      image.data[4 * i + c] = Math.min(255, Math.max(0, Math.round(v)));
    }
    image.data[4 * i + 3] = Math.round(a);
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** The master at `size` px; icons of 32 px and less get a light unsharp. */
function scaled(master, size) {
  let buffer = resize(master, size);
  if (size <= 32) buffer = sharpen(buffer, size, size <= 20 ? 0.6 : 0.45);
  return toCanvas(buffer, size);
}

/** The recording marker: a red dot with a white ring at the bottom-right of the icon. */
function withRecordingBadge(canvas, size) {
  const ctx = canvas.getContext('2d');
  const cx = size * 0.72;
  const cy = size * 0.72;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.3, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.215, 0, Math.PI * 2);
  ctx.fillStyle = '#e11d2e';
  ctx.fill();
  return canvas;
}

/** An ICO file whose images are PNGs (supported since Windows Vista). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;
  images.forEach(({ size, png }, index) => {
    const entry = index * 16;
    entries[entry] = size >= 256 ? 0 : size;
    entries[entry + 1] = size >= 256 ? 0 : size;
    entries.writeUInt16LE(1, entry + 4); // planes
    entries.writeUInt16LE(32, entry + 6); // bits per pixel
    entries.writeUInt32LE(png.length, entry + 8);
    entries.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, entries, ...images.map((image) => image.png)]);
}

// --- install loading GIF ------------------------------------------------------------------------

const GIF = { width: 400, height: 300, frames: 24, delay: 50, logo: 132, background: '#0b1020' };

/** One frame: the logo breathing in a soft glow, with a thin indeterminate progress bar below. */
function loadingFrame(master, index) {
  const { width, height, frames } = GIF;
  const phase = index / frames;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = GIF.background;
  ctx.fillRect(0, 0, width, height);

  const breath = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2); // 0..1..0 over the loop
  const cx = width / 2;
  const cy = 118;
  const radius = 120 + 18 * breath;
  const glow = ctx.createRadialGradient(cx, cy, 10, cx, cy, radius);
  glow.addColorStop(0, `rgba(99, 102, 241, ${0.32 + 0.22 * breath})`);
  glow.addColorStop(0.5, `rgba(34, 211, 238, ${0.08 + 0.07 * breath})`);
  glow.addColorStop(1, 'rgba(11, 16, 32, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  const size = Math.round(GIF.logo * (1 + 0.03 * breath));
  ctx.drawImage(master, cx - size / 2, cy - size / 2, size, size);

  const barWidth = 200;
  const barHeight = 4;
  const barX = (width - barWidth) / 2;
  const barY = 232;
  ctx.fillStyle = 'rgba(148, 163, 184, 0.18)';
  ctx.beginPath();
  ctx.roundRect(barX, barY, barWidth, barHeight, 2);
  ctx.fill();
  // A 70 px segment sweeps across and wraps (indeterminate), clipped to the track.
  const segment = 70;
  const travel = barWidth + segment;
  const head = -segment + travel * phase;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(barX, barY, barWidth, barHeight, 2);
  ctx.clip();
  const gradient = ctx.createLinearGradient(barX + head, 0, barX + head + segment, 0);
  gradient.addColorStop(0, 'rgba(34, 211, 238, 0)');
  gradient.addColorStop(0.35, '#22d3ee');
  gradient.addColorStop(0.7, '#6366f1');
  gradient.addColorStop(1, '#a855f7');
  ctx.fillStyle = gradient;
  ctx.fillRect(barX + head, barY, segment, barHeight);
  ctx.restore();
  return ctx.getImageData(0, 0, width, height).data;
}

function installGif(master) {
  const encoder = new GifEncoder(GIF.width, GIF.height, { repeat: 0, quality: 6 });
  for (let i = 0; i < GIF.frames; i++) {
    encoder.addFrame(new Uint8Array(loadingFrame(master, i)), GIF.width, GIF.height, {
      delay: GIF.delay,
    });
  }
  return encoder.finish();
}

// --- run ----------------------------------------------------------------------------------------

const clean = await cleanLogo();
const cleanData = clean.getContext('2d').getImageData(0, 0, clean.width, clean.height);
const master = toCanvas(resize({ width: clean.width, data: cleanData.data }, MASTER), MASTER);
const masterData = master.getContext('2d').getImageData(0, 0, MASTER, MASTER);
const source = { width: MASTER, data: masterData.data };
const png = (canvas) => canvas.toBuffer('image/png');
const sized = (size) => scaled(source, size);

write(at('assets', 'brand', 'framecapt-logo.png'), png(master));
for (const size of [512, 256])
  write(at('assets', 'brand', `framecapt-logo-${size}.png`), png(sized(size)));

write(
  at('assets', 'app', 'framecapt.ico'),
  ico(APP_ICO_SIZES.map((size) => ({ size, png: png(sized(size)) }))),
);
write(at('assets', 'app', 'install-loading.gif'), installGif(sized(264)));

for (const size of UI_SIZES) {
  write(at('src', 'renderer', 'assets', `logo-${size}.png`), png(sized(size)));
}

const tray = { normal: {}, recording: {} };
const trayIco = [];
for (const size of TRAY_SIZES) {
  const normal = png(sized(size));
  const recording = png(withRecordingBadge(sized(size), size));
  write(at('assets', 'tray', `tray-${size}.png`), normal);
  write(at('assets', 'tray', `tray-recording-${size}.png`), recording);
  tray.normal[size] = normal.toString('base64');
  tray.recording[size] = recording.toString('base64');
  trayIco.push({ size, png: normal });
}
write(at('assets', 'tray', 'framecapt.ico'), ico(trayIco));
write(
  at('src', 'main', 'tray-icons.generated.ts'),
  `// Generated by scripts/generate-brand-assets.mjs. Do not edit.
/** Tray icon PNGs (base64) by size: 16, 20, 24 and 32 px for 100, 125, 150 and 200 % display scaling. */
export const TRAY_ICONS = ${JSON.stringify(tray, null, 2)} as const;

/** The display scale factor each tray icon size is meant for. */
export const TRAY_SCALE_FACTORS = ${JSON.stringify(TRAY_SCALES)} as const;
`,
);
console.log('Brand assets written (assets/brand, assets/app, assets/tray, src/renderer/assets).');
