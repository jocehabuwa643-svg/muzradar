// Подготовка приложения сервера для Render Blueprints / деплоя.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirnameURL(import.meta.url), '../../..');

function dirnameURL(u) { return fileURLToPath(new URL('.', u)); }

const SERVER = join(ROOT, 'apps', 'server');

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { cwd: SERVER, stdio: 'inherit', ...opts });
}

run('npm', ['run', 'build', '--workspaces', '--if-present', '--workspace', '@muzradar/shared']);
run('npm', ['run', 'build', '--workspace', '@muzradar/server']);

const dist = join(SERVER, 'dist');
console.log('Server build done:', dist);
