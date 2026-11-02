import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const base = (process.env.EXPO_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
const withBase = (path) => `${base}${path}`;
const manifestPath = fileURLToPath(new URL('../public/manifest.json', import.meta.url));
const distManifestPath = fileURLToPath(new URL('../dist/manifest.json', import.meta.url));
const indexPath = fileURLToPath(new URL('../dist/index.html', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

manifest.id = withBase(manifest.id);
manifest.start_url = withBase(manifest.start_url);
manifest.scope = withBase(manifest.scope);
for (const icon of manifest.icons) icon.src = withBase(icon.src);

const manifestData = `data:application/manifest+json,${encodeURIComponent(JSON.stringify(manifest))}`;
const html = readFileSync(indexPath, 'utf8')
  .replaceAll('__PWA_MANIFEST_DATA__', manifestData)
  .replace(/data:application\/manifest\+json,[^"]+/, manifestData)
  .replaceAll('__PWA_BASE_URL__', base);
writeFileSync(indexPath, html);
writeFileSync(distManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Web export finalized for base URL: ${base || '/'}`);
