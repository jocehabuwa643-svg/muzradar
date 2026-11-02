import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const input = fileURLToPath(new URL('../assets/icon.png', import.meta.url));
const output = fileURLToPath(new URL('../public/', import.meta.url));
mkdirSync(output, { recursive: true });

await sharp(input).resize(192, 192).png().toFile(`${output}pwa-192.png`);
await sharp(input).resize(512, 512).png().toFile(`${output}pwa-512.png`);
await sharp({
  create: { width: 512, height: 512, channels: 4, background: '#07070C' },
})
  .composite([{ input: await sharp(input).resize(410, 410).png().toBuffer(), top: 51, left: 51 }])
  .png()
  .toFile(`${output}maskable-512.png`);
console.log('PWA icons generated.');
