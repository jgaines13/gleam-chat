/**
 * One-off script: make white or black background of avatar PNGs transparent.
 * Run: node scripts/make-avatar-transparent.js
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images');
const AVATARS = ['levis-avatar.png', 'carhartt-avatar.png'];

// Treat pixel as background if it's near white (r,g,b >= 250) or near black (r,g,b <= 10)
function isBackground(r, g, b) {
  const white = r >= 250 && g >= 250 && b >= 250;
  const black = r <= 10 && g <= 10 && b <= 10;
  return white || black;
}

async function processImage(filePath) {
  const img = sharp(filePath);
  const { data, info } = await img.raw().ensureAlpha().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const newData = Buffer.from(data);

  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    const r = newData[o];
    const g = newData[o + 1];
    const b = newData[o + 2];
    if (isBackground(r, g, b)) {
      newData[o + 3] = 0; // set alpha to transparent
    }
  }

  await sharp(newData, { raw: { width, height, channels } })
    .png()
    .toFile(filePath);
  console.log('Updated:', path.basename(filePath));
}

async function main() {
  for (const name of AVATARS) {
    const filePath = path.join(IMAGES_DIR, name);
    if (!fs.existsSync(filePath)) {
      console.warn('Skip (not found):', name);
      continue;
    }
    await processImage(filePath);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
