import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import sharp from 'sharp';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const svg = readFileSync(join(root, 'public', 'icon.svg'));

for (const size of [192, 512]) {
  await sharp(svg).resize(size, size).png().toFile(join(root, 'public', `icon-${size}.png`));
  console.log(`Generated icon-${size}.png`);
}
