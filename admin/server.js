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
import { ANTHROPIC_PROXY_PATH, AnthropicProxy } from './lib/anthropic-proxy.js';
import { applyModelConfig, normalizeModels, redactModels } from './lib/models.js';
import { applyT3ClaudeModels } from './lib/t3-models.js';
import * as multica from './lib/multica.js';
import { ManagedProcess } from './lib/procs.js';
import {
  adminToken,
  ensureDir,
  loadSettings,
  safeEqual,
  saveSettings,
} from './lib/store.js';
import { pairing, parsePairingOutput } from './lib/t3.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || '/root/.agent-hub';
const LOG_DIR = process.env.LOG_DIR || '/var/log/agent-hub';
const T3_PORT = String(process.env.T3_PORT || '3773');
const T3_BIND = process.env.T3_BIND || '0.0.0.0';
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
  args: ['serve', '--host', T3_BIND, '--port', T3_PORT, '--no-browser', '--lan', '/workspace'],
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

// Claude Code 会在 system 里带一个 `x-anthropic-billing-header:` 块，部分第三方
// 网关（例如 llms.zj-qq.cn）会因此返回 400。转发逻辑挂在管理后台自己的端口上，
// 不再单独监听端口。
const anthropicProxy = process.env.CLAUDE_PROXY === '0' ? null : new AnthropicProxy();

async function applyModels() {
  const result = applyModelConfig(settings.models);
  anthropicProxy?.configure(settings.models);
  for (const key of MANAGED_ENV) delete process.env[key];
  for (const [key, value] of Object.entries(result.env || {})) {
    if (value) process.env[key] = value;
  }
  // Claude 的额外模型不能靠环境变量，必须写进 T3 自己的 providerInstances。
  try {
    const t3Models = await applyT3ClaudeModels(settings.models);
    if (t3Models.warning) result.warnings.push(t3Models.warning);
  } catch (err) {
    result.warnings.push(`写入 T3 的 Claude 模型列表失败: ${err.message}`);
  }
  for (const warning of result.warnings || []) adminLog(`[models] ${warning}`);
  return result;
}

// T3 会缓存 OpenCode / Pi / Claude 的模型列表；只有配置真正变化时才重启。
function modelsSignature(models) {
  const profiles = (models?.profiles || [])
    .map((profile) => [
      profile.id,
      profile.protocol,
      profile.baseUrl,
      profile.anthropicBaseUrl || '',
      profile.defaultModel,
      profile.fastModel,
      (profile.models || [])
        .map((model) => `${model.id}:${model.vision ? 1 : 0}:${model.reasoning ? 1 : 0}:${model.name || ''}`)
        .join(','),
      profile.contextWindow || 0,
      profile.openaiApi,
      profile.apiKey || '',
    ].join('\u0000'))
    .sort();
  const assignments = Object.entries(models?.assignments || {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({ profiles, assignments });
}

async function waitForT3Ready(timeoutMs = 20000) {
  const host = T3_BIND === '0.0.0.0' || T3_BIND === '::' ? '127.0.0.1' : T3_BIND;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!t3.isRunning()) return false;
    try {
      const res = await fetch(`http://${host}:${T3_PORT}/`, { signal: AbortSignal.timeout(1500) });
      if (res.status < 500) return true;
    } catch {
      // 还没监听，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  adminLog(`T3 在 ${timeoutMs}ms 内没有就绪（配置已写入，可能还需要手动重启）`);
  return false;
}

const bootModels = await applyModels();
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
  // 健康检查和 Anthropic 转发不走 Basic Auth：Claude Code 只会带自己的
  // ANTHROPIC_AUTH_TOKEN，转发处理器会单独校验它是否等于配置里的 key。
  if (c.req.path === '/healthz') return next();
  if (c.req.path === ANTHROPIC_PROXY_PATH || c.req.path.startsWith(`${ANTHROPIC_PROXY_PATH}/`)) {
    return next();
  }

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

// Claude Code 的 ANTHROPIC_BASE_URL 指向这里（同端口 + 路径前缀）。
if (anthropicProxy) {
  app.all(ANTHROPIC_PROXY_PATH, (c) => anthropicProxy.handle(c));
  app.all(`${ANTHROPIC_PROXY_PATH}/*`, (c) => anthropicProxy.handle(c));
}

app.get('/', (c) => c.html(indexHtml));

app.get('/api/status', (c) =>
  c.json({
    now: Date.now(),
    t3Port: T3_PORT,
    t3Bind: T3_BIND,
    adminPort: ADMIN_PORT,
    adminBind: ADMIN_BIND,
    t3: t3.status(),
    multica: multicaProc.status(),
    multicaConfigured: Boolean(settings.multica?.serverUrl),
    modelsConfigured: Boolean(settings.models?.profiles?.length),
    anthropicProxy: anthropicProxy ? anthropicProxy.url : null,
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

// T3 自己在启动时就会把配对链接打印到 t3.log（`Pairing URL:` / `App link:` / `Token:`）。
// `t3 pair` 偶尔会在 T3 刚重启、还没就绪时失败，这时直接回退到日志里最后一条配对信息。
function pairingFromLog() {
  const lines = tailFile(path.join(LOG_DIR, 't3.log'), 2000).map((entry) => entry.line);
  return parsePairingOutput(lines.join('\n'));
}

app.post('/api/t3/pair', async (c) => {
  try {
    // 刚保存模型时后台会重启 T3；等它监听端口后再取配对链接，避免命令在启动过程中失败。
    if (t3.isRunning()) await waitForT3Ready(8000);
    let result = await pairing();
    let source = 'cli';

    if (!result.url) {
      const fromLog = pairingFromLog();
      if (fromLog.url) {
        result = {
          ...fromLog,
          code: 0,
          output: `${result.output}\n\n[已回退到 T3 启动日志] ${fromLog.pairingUrl || fromLog.url}`,
          error: '',
        };
        source = 'log';
      }
    }

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
    return c.json({ ...result, source, qrSvg });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.post('/api/t3/restart', async (c) => {
  try {
    await t3.restart();
    const ready = await waitForT3Ready();
    return c.json({ ok: true, ready, status: t3.status() });
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
    const previousModels = settings.models;
    const previousCodexId = previousModels?.assignments?.codex || null;
    const previousCodexKey =
      (previousModels?.profiles || []).find((profile) => profile.id === previousCodexId)?.apiKey || '';

    const normalized = normalizeModels(mergeSecrets(body, previousModels));
    settings.models = normalized;
    saveSettings(settings);

    const result = await applyModels();
    const nextCodexKey = result.env.AGENT_HUB_CODEX_KEY || '';
    const codexKeyChanged = previousCodexKey !== nextCodexKey;
    const modelsChanged = modelsSignature(previousModels) !== modelsSignature(normalized);

    // Codex 的 key 走环境变量，只能靠重启子进程生效；
    // OpenCode / Pi / Claude 的模型列表在 T3 启动时读取，配置变了也要重启才能刷新。
    let restarted = false;
    let ready = false;
    if ((codexKeyChanged || modelsChanged) && t3.isRunning()) {
      await t3.restart();
      ready = await waitForT3Ready();
      restarted = true;
    }
    if (codexKeyChanged && multicaProc.isRunning()) {
      await multicaProc.restart();
      restarted = true;
    }

    return c.json({
      ok: true,
      warnings: result.warnings,
      written: result.written,
      restarted,
      ready,
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