// Тестовый контур МУЗРАДАР: локальный сервер + публичный https-туннель к нему.
//   npm run tunnel:up                                      — Cloudflare quick tunnel: без аккаунта, адрес новый при каждом запуске
//   npm run tunnel:up -- ngrok                             — ngrok: нужен аккаунт (ngrok config add-authtoken <токен> — делаете сами)
//   npm run tunnel:up -- ngrok https://имя.ngrok-free.app  — ngrok на постоянном бесплатном домене: APK не пересобирать
//   npm run tunnel:up -- localhost                         — localhost.run через SSH, без аккаунта, адрес новый при каждом запуске
//   npm run tunnel:down                                    — остановить сервер и туннель, освободить порты
// Перед up: npm run export:web -w @muzradar/mobile, если PWA ещё не собрана или изменилась.
// После успешного up адрес вписывается в apps/mobile/eas.json → build.preview.env.EXPO_PUBLIC_API_URL.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8080;
const PGLITE_PORT = 54329;
const LOCAL = `http://127.0.0.1:${PORT}`;
// .data в .gitignore: логи с IP друзей и PID-ы в репозиторий не попадут
const DIR = join(ROOT, 'apps', 'server', '.data', 'tunnel');
const STATE = join(DIR, 'state.json');
const SERVER_LOG = join(DIR, 'server.log');
const TUNNEL_LOG = join(DIR, 'tunnel.log');
const SERVER_ENV = join(ROOT, 'apps', 'server', '.env');
const EAS = join(ROOT, 'apps', 'mobile', 'eas.json');
const PWA_DIR = join(ROOT, 'apps', 'mobile', 'dist');
const IS_WIN = process.platform === 'win32';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readLog = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
const tail = (file, lines = 8) => readLog(file).trim().split(/\r?\n/).slice(-lines).join('\n');

/** Опрашивать probe(), пока не вернёт значение; probe может бросить, чтобы прервать ожидание. */
async function waitFor(probe, timeoutMs, stepMs = 1_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await probe();
    if (value) return value;
    await sleep(stepMs);
  }
  return null;
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid) {
  if (!alive(pid)) return;
  try {
    if (IS_WIN) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGTERM');
  } catch {
    // процесс успел завершиться сам
  }
}

/** PID-ы, слушающие указанные порты. */
function listeners(ports) {
  try {
    if (IS_WIN) {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
        if (m && ports.includes(Number(m[1]))) pids.add(Number(m[2]));
      }
      return [...pids];
    }
    const out = execFileSync('lsof', ['-t', ...ports.map((p) => `-iTCP:${p}`), '-sTCP:LISTEN'], { encoding: 'utf8' });
    return [...new Set(out.split(/\s+/).filter(Boolean).map(Number))];
  } catch {
    return [];
  }
}

/** Туннели, запущенные на наш порт (если state.json потерялся). */
function strayTunnels() {
  if (!IS_WIN) return [];
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe' OR Name='ngrok.exe'" | Where-Object { $_.CommandLine -match ':${PORT}' } | ForEach-Object { $_.ProcessId }`,
      ],
      { encoding: 'utf8' },
    );
    return out.split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function findBinary(name, knownPaths) {
  try {
    const out = execFileSync(IS_WIN ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).find(Boolean);
    if (first) return first.trim();
  } catch {
    // нет в PATH — например, winget поставил программу после открытия этого окна
  }
  return knownPaths.find((p) => existsSync(p)) ?? null;
}

const PROVIDERS = {
  cloudflare: {
    label: 'Cloudflare quick tunnel',
    binary: () =>
      findBinary('cloudflared', [
        join(process.env['ProgramFiles(x86)'] ?? '', 'cloudflared', 'cloudflared.exe'),
        join(process.env.ProgramFiles ?? '', 'cloudflared', 'cloudflared.exe'),
      ]),
    install: 'winget install --id Cloudflare.cloudflared -e',
    args: () => ['tunnel', '--no-autoupdate', '--url', LOCAL],
    stable: false,
    async publicUrl() {
      const url = await waitFor(() => readLog(TUNNEL_LOG).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0], 60_000);
      if (!url) throw new Error(`cloudflared не выдал адрес за 60 с. Лог:\n${tail(TUNNEL_LOG)}`);
      // Адрес выдаётся раньше, чем поднимется соединение с краем Cloudflare, — ждём именно его.
      const startedAt = Date.now();
      const registered = await waitFor(() => {
        const log = readLog(TUNNEL_LOG);
        if (/Registered tunnel connection/.test(log)) return true;
        if (Date.now() - startedAt > 40_000 && /Failed to dial|TLS handshake with edge error|hard_fail=true/.test(log)) {
          throw new Error(
            'Cloudflare не пускает этот ПК: исходящий порт 7844 (QUIC/UDP и TCP) не проходит — его режет VPN или провайдер.\n' +
              '  Варианты: выключить VPN / исключить cloudflared.exe из VPN и повторить; или запасной ngrok: npm run tunnel:up -- ngrok',
          );
        }
        return false;
      }, 120_000);
      if (!registered) throw new Error(`cloudflared не соединился с Cloudflare за 120 с. Лог:\n${tail(TUNNEL_LOG)}`);
      return url;
    },
  },
  ngrok: {
    label: 'ngrok',
    binary: () =>
      findBinary('ngrok', [
        join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'ngrok.exe'),
        join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages', 'Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ngrok.exe'),
      ]),
    // в winget лежит старый агент — `ngrok update` доводит его до актуального
    install: 'winget install --id Ngrok.Ngrok -e, затем ngrok update',
    // --domain понимают и старые, и новые агенты (в новых есть синоним --url)
    args: (fixedUrl) => ['http', LOCAL, '--log', 'stdout', ...(fixedUrl ? ['--domain', new URL(fixedUrl).host] : [])],
    stable: true,
    async publicUrl(tunnelPid, fixedUrl) {
      const url = await waitFor(async () => {
        if (!alive(tunnelPid)) {
          const log = readLog(TUNNEL_LOG);
          if (/ERR_NGROK_4018|authtoken/i.test(log)) {
            throw new Error(
              'ngrok требует аккаунт. Зарегистрируйтесь на ngrok.com и выполните сами (токен в код и чат не вставлять):\n' +
                '  ngrok config add-authtoken <ваш токен>',
            );
          }
          throw new Error(`ngrok завершился. Лог:\n${tail(TUNNEL_LOG)}`);
        }
        try {
          // локальный API агента ngrok
          const res = await fetch('http://127.0.0.1:4040/api/tunnels', { signal: AbortSignal.timeout(2_000) });
          const body = await res.json();
          return body.tunnels?.find((t) => String(t.public_url).startsWith('https://'))?.public_url ?? null;
        } catch {
          return null;
        }
      }, 60_000);
      if (!url) throw new Error(`ngrok не выдал адрес за 60 с. Лог:\n${tail(TUNNEL_LOG)}`);
      if (fixedUrl && url.replace(/\/+$/, '') !== fixedUrl) throw new Error(`ngrok выдал ${url}, а просили ${fixedUrl}`);
      return url.replace(/\/+$/, '');
    },
  },
  localhost: {
    label: 'localhost.run',
    binary: () => findBinary('ssh', [join(process.env.SystemRoot ?? '', 'System32', 'OpenSSH', 'ssh.exe')]),
    install: 'Windows OpenSSH Client (обычно уже встроен)',
    args: () => [
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'ServerAliveInterval=30',
      '-R',
      `80:127.0.0.1:${PORT}`,
      'nokey@localhost.run',
    ],
    stable: false,
    async publicUrl(tunnelPid) {
      const url = await waitFor(() => {
        if (!alive(tunnelPid)) throw new Error(`localhost.run завершился. Лог:\n${tail(TUNNEL_LOG)}`);
        return readLog(TUNNEL_LOG).match(/https:\/\/[a-z0-9]+\.lhr\.life/)?.[0];
      }, 60_000);
      if (!url) throw new Error(`localhost.run не выдал адрес за 60 с. Лог:\n${tail(TUNNEL_LOG)}`);
      return url;
    },
  },
};

/** Наружу сервер выходит только со своими секретами: dev-заглушки из config.ts публичны вместе с кодом. */
function assertSecrets() {
  const text = readLog(SERVER_ENV);
  const missing = ['JWT_SECRET', 'PRESENCE_JITTER_SECRET', 'ANDROID_ID_PEPPER'].filter((key) => {
    const value = text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
    return value.length < 32;
  });
  if (missing.length) {
    throw new Error(
      `в apps/server/.env не заданы ${missing.join(', ')} (≥ 32 символа). Сгенерировать значение:\n` +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`,
    );
  }
}

async function health(base, timeoutMs) {
  return waitFor(async () => {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }, timeoutMs, 1_500);
}

function spawnDetached(command, args, logFile, cwd = ROOT) {
  const fd = openSync(logFile, 'a');
  const child = spawn(command, args, { cwd, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  child.unref();
  return child.pid;
}

function setPreviewUrl(url) {
  const eas = JSON.parse(readFileSync(EAS, 'utf8'));
  eas.build.preview.env.EXPO_PUBLIC_API_URL = url;
  writeFileSync(EAS, `${JSON.stringify(eas, null, 2)}\n`);
}

async function up(providerName = 'cloudflare', fixedUrl) {
  const provider = PROVIDERS[providerName];
  if (!provider) throw new Error(`неизвестный туннель «${providerName}»: cloudflare или ngrok`);
  if (fixedUrl && (providerName !== 'ngrok' || !/^https:\/\/[a-z0-9.-]+$/i.test(fixedUrl))) {
    throw new Error('постоянный адрес задаётся только для ngrok, вида https://имя.ngrok-free.app');
  }

  const state = readState();
  if (state?.url && alive(state.serverPid) && alive(state.tunnelPid)) {
    console.log(`Уже запущено (${state.provider}): ${state.url}\nОстановить: npm run tunnel:down`);
    return;
  }
  if (state) down(true);

  assertSecrets();
  const binary = provider.binary();
  if (!binary) throw new Error(`${provider.label} не установлен. Установить: ${provider.install}`);
  const busy = listeners([PORT, PGLITE_PORT]);
  if (busy.length) throw new Error(`порт ${PORT} или ${PGLITE_PORT} занят (PID ${busy.join(', ')}). Остановить: npm run tunnel:down`);

  mkdirSync(DIR, { recursive: true });
  writeFileSync(SERVER_LOG, '');
  writeFileSync(TUNNEL_LOG, '');
  if (existsSync(join(PWA_DIR, 'index.html'))) process.env['PWA_STATIC_DIR'] = PWA_DIR;
  else console.warn('PWA не собрана: сначала выполните npm run export:web -w @muzradar/mobile. Туннель поднимет только API.');
  // То же, что `npm run dev:server`, но без прослойки cmd → npm: через неё вывод сервера не доходил до лога.
  const serverPid = spawnDetached(
    process.execPath,
    [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'watch', '--conditions=@muzradar/source', 'src/index.ts'],
    SERVER_LOG,
    join(ROOT, 'apps', 'server'),
  );
  const tunnelPid = spawnDetached(binary, provider.args(fixedUrl), TUNNEL_LOG);
  writeFileSync(STATE, JSON.stringify({ provider: providerName, serverPid, tunnelPid, url: null }, null, 2));

  try {
    console.log('Сервер поднимается…');
    const local = await health(LOCAL, 90_000);
    if (!local) throw new Error(`сервер не ответил на ${LOCAL}/health за 90 с. Лог:\n${tail(SERVER_LOG)}`);

    console.log(`${provider.label} поднимается…`);
    const url = await provider.publicUrl(tunnelPid, fixedUrl);
    writeFileSync(STATE, JSON.stringify({ provider: providerName, serverPid, tunnelPid, url }, null, 2));

    const remote = await health(url, 60_000);
    if (!remote) throw new Error(`${url}/health не отвечает за 60 с. Лог туннеля:\n${tail(TUNNEL_LOG)}`);

    setPreviewUrl(url);
    console.log(
      [
        '',
        `Туннель:  ${url}  (${provider.label})`,
        `Проверка: ${url}/health → ${JSON.stringify(remote)}`,
        `Сокеты:   ${url.replace(/^https/, 'wss')}/v1/realtime`,
        'eas.json → preview.EXPO_PUBLIC_API_URL обновлён.',
        fixedUrl
          ? 'Адрес постоянный: собранный под него APK переживёт перезапуск туннеля.'
          : 'Адрес сменится при следующем up — APK, собранный под этот адрес, работает, только пока жив этот туннель.',
        `Логи:     ${DIR}`,
        'Остановить: npm run tunnel:down',
      ].join('\n'),
    );
  } catch (err) {
    down(true);
    throw err;
  }
}

function down(quiet = false) {
  const state = readState();
  killTree(state?.tunnelPid);
  killTree(state?.serverPid);
  // подстраховка: сервер мог быть запущен вручную, а state.json — потеряться
  for (const pid of [...strayTunnels(), ...listeners([PORT, PGLITE_PORT])]) killTree(pid);
  rmSync(STATE, { force: true });
  if (quiet) return;
  const left = listeners([PORT, PGLITE_PORT]);
  console.log(left.length ? `Порты всё ещё заняты: PID ${left.join(', ')}` : `Остановлено. Порты ${PORT} и ${PGLITE_PORT} свободны.`);
}

const [command, providerName, fixedUrl] = process.argv.slice(2);
try {
  if (command === 'up') await up(providerName, fixedUrl);
  else if (command === 'down') down();
  else {
    console.log('Использование: node scripts/tunnel.mjs up [cloudflare|ngrok [https://имя.ngrok-free.app]|localhost] | down');
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
