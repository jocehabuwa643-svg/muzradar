// Проверяет манифест после `expo prebuild`: нужные разрешения есть, запрещённые вырезаны.
// Это манифест ДО слияния с манифестами библиотек (Gradle), поэтому запреты проверяются по tools:node="remove".
import { readFileSync } from 'node:fs';

const xml = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
const entries = [...xml.matchAll(/<uses-permission\s+android:name="([^"]+)"([^>]*)>/g)];
const removed = new Set(entries.filter(([, , attrs]) => attrs.includes('tools:node="remove"')).map(([, name]) => name));
const declared = new Set(entries.filter(([, , attrs]) => !attrs.includes('tools:node="remove"')).map(([, name]) => name));
const P = (s) => `android.permission.${s}`;

const live = process.env.LIVE_LOCATION === '1';
const mustHave = ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_MEDIA_PLAYBACK', ...(live ? ['FOREGROUND_SERVICE_LOCATION'] : [])].map(P);
const mustBeRemoved = ['RECORD_AUDIO', 'ACCESS_BACKGROUND_LOCATION', 'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'READ_MEDIA_IMAGES', 'READ_MEDIA_VIDEO', 'READ_MEDIA_VISUAL_USER_SELECTED'].map(P);
const mustNotHave = live ? [] : [P('FOREGROUND_SERVICE_LOCATION')];

const errors = [
  ...mustHave.filter((p) => !declared.has(p)).map((p) => `missing ${p}`),
  ...mustBeRemoved.filter((p) => !removed.has(p)).map((p) => `not blocked ${p}`),
  ...mustBeRemoved.filter((p) => declared.has(p)).map((p) => `declared ${p}`),
  ...mustNotHave.filter((p) => declared.has(p)).map((p) => `unexpected ${p}`),
];
if (!/foregroundServiceType="mediaPlayback"/.test(xml)) errors.push('no mediaPlayback foreground service');

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`ok: ${declared.size} declared, ${removed.size} blocked`);
console.log([...declared].sort().join('\n'));
