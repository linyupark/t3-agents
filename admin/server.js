import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAgents, updateAgent } from './lib/agents.js';
import {
  applyBrowserConfig,
  browserSnapshot,
  installMcp,
  normalizeBrowserSettings,
  probeCdp,
} from './lib/browser.js';
import { applyModelConfig, normalizeModels, redactModels } from './lib/models.js';
import * as multica from './lib/multica.js';
import { ManagedProcess } from './lib/procs.js';
import {
  adminToken,
  ensureDir,
  loadSettings,
  safeEqual,
  saveSettings,
} from './lib/store.js';
import { pairing } from './lib/t3.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || '/root/.agent-hub';
const LOG_DIR = process.env.LOG_DIR || '/var/log/agent-hub';
const T3_PORT = String(process.env.T3_PORT || '3773');
const ADMIN_PORT = Number(process.env.ADMIN_PORT || '3774');
const ADMIN_BIND = process.env.ADMIN_BIND || '0.0.0.0';
const MANAGED_ENV = ['AGENT_HUB_CODEX_KEY'];

ensureDir(DATA_DIR, 0o700);
ensureDir(LOG_DIR, 0o755);

function adminLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(LOG_DIR, 'admin.log'), `${line}\n`);
  } catch {
    // 日志失败不阻塞
  }
}

function tailFile(file, count) {
  try {
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, 512 * 1024);
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, stat.size - size);
    fs.closeSync(fd);
    return buffer
      .toString('utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-count)
      .map((line) => ({ t: Date.now(), stream: 'admin', line }));
  } catch {
    return [];
  }
}

let settings = loadSettings();
const token = adminToken();

const t3 = new ManagedProcess('t3', {
  cmd: 't3',
  args: ['serve', '--host', '0.0.0.0', '--port', T3_PORT, '--no-browser', '--lan', '/workspace'],
  cwd: '/workspace',
  logFile: path.join(LOG_DIR, 't3.log'),
  restart: true,
});

const multicaProc = new ManagedProcess('multica', {
  cmd: 'multica',
  args: ['daemon', 'start', '--foreground'],
  cwd: '/workspace',
  logFile: path.join(LOG_DIR, 'multica.log'),
  restart: true,
});

async function multicaAvailable() {
  const result = await multica.version();
  return result.code === 0;
}

function applyModels() {
  const result = applyModelConfig(settings.models);
  for (const key of MANAGED_ENV) delete process.env[key];
  for (const [key, value] of Object.entries(result.env || {})) {
    if (value) process.env[key] = value;
  }
  for (const warning of result.warnings || []) adminLog(`[models] ${warning}`);
  return result;
}

const bootModels = applyModels();
adminLog(
  `models applied at boot: ${bootModels.written.length} file(s), ${bootModels.warnings.length} warning(s)`,
);

applyBrowserConfig(settings.browser)
  .then((result) => {
    adminLog(
      `browser CDP applied at boot: ${result.written.length} written, ${result.removed.length} removed, ${result.warnings.length} warning(s)`,
    );
    for (const warning of result.warnings) adminLog(`[browser] ${warning}`);
  })
  .catch((err) => adminLog(`[browser] apply failed: ${err.message}`));

const app = new Hono();

app.use('*', async (c, next) => {
  if (c.req.path === '/healthz') return next();

  const header = c.req.header('authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) {
    return c.text('Authentication required', 401, {
      'WWW-Authenticate': 'Basic realm="Agent Hub", charset="UTF-8"',
    });
  }

  let supplied = '';
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    supplied = decoded.slice(decoded.indexOf(':') + 1);
  } catch {
    supplied = '';
  }

  if (!safeEqual(supplied, token)) {
    return c.text('Unauthorized', 401, {
      'WWW-Authenticate': 'Basic realm="Agent Hub", charset="UTF-8"',
    });
  }
  return next();
});

app.use('/api/*', async (c, next) => {
  const length = Number(c.req.header('content-length') || '0');
  if (length > 200_000) return c.json({ error: '请求体过大' }, 413);
  return next();
});

const indexHtml = fs.readFileSync(path.join(APP_DIR, 'public', 'index.html'), 'utf8');

app.get('/healthz', (c) => c.text('ok'));
app.get('/', (c) => c.html(indexHtml));

app.get('/api/status', (c) =>
  c.json({
    now: Date.now(),
    t3Port: T3_PORT,
    adminPort: ADMIN_PORT,
    t3: t3.status(),
    multica: multicaProc.status(),
    multicaConfigured: Boolean(settings.multica?.serverUrl),
    modelsConfigured: Boolean(settings.models?.profiles?.length),
  }),
);

app.get('/api/agents', async (c) => {
  try {
    return c.json({ agents: await listAgents(), prefix: process.env.NPM_CONFIG_PREFIX || '/opt/agents' });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.post('/api/agents/:key/update', async (c) => {
  try {
    const result = await updateAgent(c.req.param('key'));
    return c.json(result);
  } catch (err) {
    return c.json({ ok: false, error: err.message, output: '' }, 500);
  }
});

app.post('/api/t3/pair', async (c) => {
  try {
    const result = await pairing();
    let qrSvg = null;
    if (result.url) {
      try {
        qrSvg = await QRCode.toString(result.url, {
          type: 'svg',
          margin: 1,
          width: 240,
          errorCorrectionLevel: 'M',
        });
      } catch {
        qrSvg = null;
      }
    }
    return c.json({ ...result, qrSvg });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.post('/api/t3/restart', async (c) => {
  try {
    await t3.restart();
    return c.json({ ok: true, status: t3.status() });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.get('/api/browser', async (c) => {
  try {
    return c.json(await browserSnapshot(settings.browser));
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.post('/api/browser/test', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const cdpUrl = body.cdpUrl ?? settings.browser?.cdpUrl;
    const result = await probeCdp(cdpUrl, { timeoutMs: 5000 });
    return c.json(result);
  } catch (err) {
    return c.json({ ok: false, error: err.message }, 400);
  }
});

app.post('/api/browser/install', async (c) => {
  try {
    const result = await installMcp();
    return c.json(result);
  } catch (err) {
    return c.json({ ok: false, output: '', error: err.message }, 500);
  }
});

app.put('/api/browser', async (c) => {
  try {
    const body = await c.req.json();
    const next = normalizeBrowserSettings(body, settings.browser);
    settings.browser = next;
    saveSettings(settings);

    const result = await applyBrowserConfig(next);
    return c.json({
      ok: true,
      ...result,
      browser: await browserSnapshot(next),
    });
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

function mergeSecrets(incoming, existing) {
  const previous = new Map((existing?.profiles || []).map((profile) => [profile.id, profile]));
  const profiles = (Array.isArray(incoming?.profiles) ? incoming.profiles : []).map((profile) => {
    const apiKey = String(profile?.apiKey || '').trim();
    const old = previous.get(String(profile?.id || '').trim());
    return { ...profile, apiKey: apiKey || old?.apiKey || '' };
  });
  return { ...incoming, profiles };
}

app.get('/api/models', (c) => c.json(redactModels(settings.models)));

app.put('/api/models', async (c) => {
  try {
    const body = await c.req.json();
    const previousCodexId = settings.models?.assignments?.codex || null;
    const previousCodexKey =
      (settings.models?.profiles || []).find((profile) => profile.id === previousCodexId)?.apiKey || '';

    const normalized = normalizeModels(mergeSecrets(body, settings.models));
    settings.models = normalized;
    saveSettings(settings);

    const result = applyModels();
    const nextCodexKey = result.env.AGENT_HUB_CODEX_KEY || '';
    // Codex 的 key 走环境变量，只能靠重启子进程生效；分配被移除时也要重启清掉旧 key
    let restarted = false;
    if (previousCodexKey !== nextCodexKey) {
      await t3.restart();
      restarted = true;
      if (multicaProc.isRunning()) {
        await multicaProc.restart();
        restarted = true;
      }
    }

    return c.json({
      ok: true,
      warnings: result.warnings,
      written: result.written,
      restarted,
      models: redactModels(settings.models),
    });
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

function validateUrl(value, field) {
  const text = String(value || '').trim();
  if (!text) return '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${field} 不是合法 URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${field} 必须是 http/https URL`);
  }
  return text.replace(/\/+$/, '');
}

function redactSteps(steps, secret) {
  return steps.map((step) => {
    const clean = { ...step };
    for (const key of ['stdout', 'stderr', 'error']) {
      if (typeof clean[key] === 'string' && secret) {
        clean[key] = clean[key].split(secret).join('***');
      }
    }
    return clean;
  });
}

app.get('/api/multica', async (c) => {
  const version = await multica.version();
  return c.json({
    serverUrl: settings.multica?.serverUrl || '',
    appUrl: settings.multica?.appUrl || '',
    hasToken: Boolean(settings.multica?.token),
    autoStart: settings.multica?.autoStart !== false,
    proc: multicaProc.status(),
    version: version.stdout.trim() || version.stderr.trim() || null,
    binary: process.env.MULTICA_BIN || 'multica',
  });
});

app.put('/api/multica', async (c) => {
  try {
    const body = await c.req.json();
    const serverUrl = validateUrl(body.serverUrl, 'serverUrl');
    const appUrl = validateUrl(body.appUrl, 'appUrl');
    const suppliedToken = String(body.token || '').trim();
    if (suppliedToken && !/^[A-Za-z0-9_.:\-]{8,300}$/.test(suppliedToken)) {
      return c.json({ error: 'token 格式不合法' }, 400);
    }

    const previous = settings.multica || {};
    const next = {
      serverUrl,
      appUrl,
      autoStart: body.autoStart !== false,
      token: suppliedToken || previous.token || '',
    };
    const forceLogin = Boolean(previous.serverUrl && previous.serverUrl !== serverUrl);

    settings.multica = next;
    saveSettings(settings);

    let steps = [];
    if (next.serverUrl) {
      steps = await multica.configure(next, { forceLogin });
    }
    if (next.autoStart && next.serverUrl) {
      if (!multicaProc.isRunning()) multicaProc.start();
    } else {
      await multicaProc.stop();
    }

    return c.json({
      ok: true,
      steps: redactSteps(steps, next.token),
      proc: multicaProc.status(),
    });
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

app.post('/api/multica/login', async (c) => {
  try {
    const config = settings.multica || {};
    if (!config.token) return c.json({ error: '还没有保存 token' }, 400);
    if (!(await multicaAvailable())) return c.json({ error: 'Multica CLI 未安装，请先点“安装/升级 CLI”' }, 400);
    const steps = await multica.configure(config, { forceLogin: true });
    return c.json({ ok: true, steps: redactSteps(steps, config.token) });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.post('/api/multica/start', async (c) => {
  const config = settings.multica || {};
  if (!config.serverUrl) return c.json({ error: '请先保存 Multica 配置' }, 400);
  if (!(await multicaAvailable())) return c.json({ error: 'Multica CLI 未安装，请先点“安装/升级 CLI”' }, 400);
  if (!multicaProc.isRunning()) multicaProc.start();
  return c.json({ ok: true, proc: multicaProc.status() });
});

app.post('/api/multica/stop', async (c) => {
  await multicaProc.stop();
  return c.json({ ok: true, proc: multicaProc.status() });
});

app.post('/api/multica/restart', async (c) => {
  const config = settings.multica || {};
  if (!config.serverUrl) return c.json({ error: '请先保存 Multica 配置' }, 400);
  if (!(await multicaAvailable())) return c.json({ error: 'Multica CLI 未安装，请先点“安装/升级 CLI”' }, 400);
  await multicaProc.restart();
  return c.json({ ok: true, proc: multicaProc.status() });
});

app.post('/api/multica/install', async (c) => {
  try {
    const result = await multica.installCli();
    return c.json(result);
  } catch (err) {
    return c.json({ code: 1, error: err.message, stdout: '', stderr: '' }, 500);
  }
});

app.get('/api/logs/:source', (c) => {
  const source = c.req.param('source');
  const count = Math.max(1, Math.min(Number(c.req.query('lines') || '200') || 200, 1000));

  if (source === 't3') return c.json({ source, lines: t3.tail(count) });
  if (source === 'multica') return c.json({ source, lines: multicaProc.tail(count) });
  if (source === 'admin') return c.json({ source, lines: tailFile(path.join(LOG_DIR, 'admin.log'), count) });
  return c.json({ error: '未知日志来源' }, 404);
});

app.onError((err, c) => {
  adminLog(`[error] ${err.message}`);
  return c.json({ error: err.message }, 500);
});

const server = (() => {
  try {
    const instance = serve(
      { fetch: app.fetch, port: ADMIN_PORT, hostname: ADMIN_BIND },
      (info) => adminLog(`admin listening on http://${ADMIN_BIND}:${info.port}`),
    );
    instance.on('error', (err) => {
      adminLog(`admin server error: ${err.message}`);
    });
    return instance;
  } catch (err) {
    adminLog(`admin server failed to start: ${err.message}`);
    return null;
  }
})();

// 启动顺序：模型配置已应用 -> t3 -> 恢复 Multica
t3.start();

if (process.env.AUTOSTART_MULTICA !== '0' && settings.multica?.serverUrl) {
  (async () => {
    if (!(await multicaAvailable())) {
      adminLog('[multica] CLI 未安装或不可用，跳过自动启动；可在管理后台点“安装/升级 CLI”');
      return;
    }
    try {
      const steps = await multica.configure(settings.multica, { forceLogin: false });
      for (const step of steps) {
        if (step.stderr || step.error) {
          adminLog(`[multica] ${step.step} failed: ${step.stderr || step.error}`);
        }
      }
    } catch (err) {
      adminLog(`[multica] configure failed: ${err.message}`);
    }
    if (settings.multica.autoStart !== false) multicaProc.start();
  })();
}

const shutdown = async (signal) => {
  adminLog(`received ${signal}, stopping children`);
  await Promise.allSettled([t3.stop(), multicaProc.stop()]);
  process.exit(0);
};

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});