import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { updateAgent } from './agents.js';
import { DEFAULT_CDP_URL, writeJson } from './store.js';

export const MCP_NAME = 'agenthub-cdp';

const NPM_PREFIX = process.env.NPM_CONFIG_PREFIX || '/opt/agents';
const PROBE_TIMEOUT_MS = 2500;
const T3_BROWSER_TTL_MS = 30000;

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: opts.timeout ?? 20000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...(opts.env || {}) },
      },
      (err, stdout, stderr) => {
        resolve({
          code: typeof err?.code === 'number' ? err.code : err ? 1 : 0,
          stdout: stdout || '',
          stderr: stderr || '',
          error: err ? err.message : '',
        });
      },
    );
  });
}

function parseVersion(text) {
  const match = String(text).match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match ? match[1] : null;
}

function displayPath(file) {
  const home = os.homedir();
  return file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
}

export function normalizeCdpUrl(value) {
  let text = String(value || '').trim();
  if (!text) return '';

  let parsed;
  try {
    if (/^wss?:\/\//i.test(text)) {
      const ws = new URL(text);
      text = `${ws.protocol === 'wss:' ? 'https:' : 'http:'}//${ws.host}`;
    }
    parsed = new URL(text);
  } catch {
    throw new Error('CDP 地址不是合法 URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('CDP 地址必须是 http/https（或 ws/wss）');
  }
  if (parsed.username || parsed.password) {
    throw new Error('CDP 地址不要包含用户名密码');
  }
  if (!parsed.hostname) throw new Error('CDP 地址缺少主机名');

  let pathname = parsed.pathname.replace(/\/+$/, '');
  if (pathname === '/json/version' || pathname === '/json/list' || pathname.startsWith('/devtools/')) {
    pathname = '';
  }
  return `${parsed.protocol}//${parsed.host}${pathname}`.replace(/\/+$/, '');
}

export function normalizeBrowserSettings(input, previous = {}) {
  const enabled = input?.enabled === undefined
    ? previous.enabled !== false
    : input.enabled === true;
  const rawUrl = input?.cdpUrl === undefined
    ? String(previous.cdpUrl ?? DEFAULT_CDP_URL)
    : String(input.cdpUrl || '');
  const cdpUrl = normalizeCdpUrl(rawUrl);
  if (enabled && !cdpUrl) throw new Error('启用 CDP 时必须填写地址');
  return { enabled, cdpUrl };
}

export async function probeCdp(cdpUrl, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  let base;
  try {
    base = normalizeCdpUrl(cdpUrl);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!base) return { ok: false, error: '未配置 CDP 地址' };

  const url = `${base}/json/version`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, url, error: `HTTP ${res.status}` };
    const data = await res.json();
    return {
      ok: true,
      url,
      browser: typeof data.Browser === 'string' ? data.Browser : '',
      protocolVersion: typeof data['Protocol-Version'] === 'string' ? data['Protocol-Version'] : '',
      userAgent: typeof data['User-Agent'] === 'string' ? data['User-Agent'] : '',
      webSocketDebuggerUrl: typeof data.webSocketDebuggerUrl === 'string' ? data.webSocketDebuggerUrl : '',
    };
  } catch (err) {
    return {
      ok: false,
      url,
      error: err?.name === 'TimeoutError' ? '连接超时' : err.message,
    };
  }
}

export function mcpBinary() {
  const override = String(process.env.CHROME_DEVTOOLS_MCP_BIN || '').trim();
  const candidates = [
    override,
    path.join(NPM_PREFIX, 'bin', 'chrome-devtools-mcp'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // 继续找
    }
  }

  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'chrome-devtools-mcp');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // 继续找
    }
  }
  return null;
}

export async function mcpInfo() {
  const bin = mcpBinary();
  if (!bin) return { installed: false, path: null, version: null };
  const result = await run(bin, ['--version'], { timeout: 5000 });
  return {
    installed: true,
    path: bin,
    version: result.code === 0 ? parseVersion(`${result.stdout}\n${result.stderr}`) : null,
  };
}

export async function installMcp() {
  const result = await updateAgent('cdp');
  return { ...result, mcp: await mcpInfo() };
}

function claudeStateFile() {
  if (process.env.CLAUDE_CONFIG_DIR) {
    return path.join(path.resolve(process.env.CLAUDE_CONFIG_DIR), '.claude.json');
  }
  return path.join(os.homedir(), '.claude.json');
}

function codexConfigFile() {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

function openCodeConfigFile() {
  return path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
}

function piMcpFile() {
  return path.join(os.homedir(), '.pi', 'agent', 'mcp.json');
}

function readJsonObject(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return {};
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${displayPath(file)} 顶层不是 JSON 对象`);
  }
  return value;
}

function mcpEntry(bin, cdpUrl) {
  return {
    command: bin,
    args: [`--browser-url=${cdpUrl}`],
  };
}

function writeClaude(cdpUrl, bin, written) {
  const file = claudeStateFile();
  const doc = readJsonObject(file);
  if (!doc.mcpServers || typeof doc.mcpServers !== 'object' || Array.isArray(doc.mcpServers)) {
    doc.mcpServers = {};
  }
  doc.mcpServers[MCP_NAME] = {
    type: 'stdio',
    ...mcpEntry(bin, cdpUrl),
    env: {},
  };
  writeJson(file, doc, 0o600);
  written.push(displayPath(file));
}

function removeClaude(removed) {
  const file = claudeStateFile();
  if (!fs.existsSync(file)) return;
  const doc = readJsonObject(file);
  if (!doc.mcpServers || typeof doc.mcpServers !== 'object' || !(MCP_NAME in doc.mcpServers)) return;
  delete doc.mcpServers[MCP_NAME];
  writeJson(file, doc, 0o600);
  removed.push(displayPath(file));
}

async function writeCodex(cdpUrl, bin, written) {
  await run('codex', ['mcp', 'remove', MCP_NAME], { timeout: 15000 });
  const result = await run(
    'codex',
    ['mcp', 'add', MCP_NAME, '--', bin, `--browser-url=${cdpUrl}`],
    { timeout: 30000 },
  );
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout || result.error || 'codex mcp add 失败').trim());
  }
  written.push('~/.codex/config.toml');
}

async function removeCodex(removed) {
  const result = await run('codex', ['mcp', 'remove', MCP_NAME], { timeout: 15000 });
  if (result.code === 0) removed.push('~/.codex/config.toml');
}

function writeOpenCode(cdpUrl, bin, written) {
  const file = openCodeConfigFile();
  const doc = readJsonObject(file);
  doc.$schema = doc.$schema || 'https://opencode.ai/config.json';
  if (!doc.mcp || typeof doc.mcp !== 'object' || Array.isArray(doc.mcp)) doc.mcp = {};
  if (!doc.mcp.servers || typeof doc.mcp.servers !== 'object' || Array.isArray(doc.mcp.servers)) {
    doc.mcp.servers = {};
  }
  doc.mcp.servers[MCP_NAME] = {
    type: 'local',
    command: [bin, `--browser-url=${cdpUrl}`],
  };
  writeJson(file, doc, 0o600);
  written.push(displayPath(file));
}

function removeOpenCode(removed) {
  const file = openCodeConfigFile();
  if (!fs.existsSync(file)) return;
  const doc = readJsonObject(file);
  const servers = doc.mcp?.servers;
  if (!servers || typeof servers !== 'object' || !(MCP_NAME in servers)) return;
  delete servers[MCP_NAME];
  if (!Object.keys(servers).length) delete doc.mcp.servers;
  if (doc.mcp && typeof doc.mcp === 'object' && !Object.keys(doc.mcp).length) delete doc.mcp;
  writeJson(file, doc, 0o600);
  removed.push(displayPath(file));
}

function writePi(cdpUrl, bin, written) {
  const file = piMcpFile();
  const doc = readJsonObject(file);
  if (!doc.mcpServers || typeof doc.mcpServers !== 'object' || Array.isArray(doc.mcpServers)) {
    doc.mcpServers = {};
  }
  doc.mcpServers[MCP_NAME] = {
    ...mcpEntry(bin, cdpUrl),
    exposure: 'direct',
  };
  writeJson(file, doc, 0o600);
  written.push(displayPath(file));
}

function removePi(removed) {
  const file = piMcpFile();
  if (!fs.existsSync(file)) return;
  const doc = readJsonObject(file);
  if (!doc.mcpServers || typeof doc.mcpServers !== 'object' || !(MCP_NAME in doc.mcpServers)) return;
  delete doc.mcpServers[MCP_NAME];
  writeJson(file, doc, 0o600);
  removed.push(displayPath(file));
}

export function configuredAgents() {
  const result = { claude: false, codex: false, opencode: false, pi: false };

  try {
    result.claude = Boolean(readJsonObject(claudeStateFile()).mcpServers?.[MCP_NAME]);
  } catch {
    // 配置损坏时按未配置处理
  }

  try {
    const file = codexConfigFile();
    if (fs.existsSync(file)) {
      const doc = parseToml(fs.readFileSync(file, 'utf8'));
      result.codex = Boolean(doc.mcp_servers?.[MCP_NAME]);
    }
  } catch {
    // 配置损坏时按未配置处理
  }

  try {
    result.opencode = Boolean(readJsonObject(openCodeConfigFile()).mcp?.servers?.[MCP_NAME]);
  } catch {
    // 配置损坏时按未配置处理
  }

  try {
    result.pi = Boolean(readJsonObject(piMcpFile()).mcpServers?.[MCP_NAME]);
  } catch {
    // 配置损坏时按未配置处理
  }

  return result;
}

export async function applyBrowserConfig(browser) {
  const warnings = [];
  const written = [];
  const removed = [];
  const enabled = browser?.enabled !== false;

  let cdpUrl = '';
  try {
    cdpUrl = normalizeCdpUrl(browser?.cdpUrl);
  } catch (err) {
    warnings.push(err.message);
  }

  const bin = enabled && cdpUrl ? mcpBinary() : null;
  if (enabled && !cdpUrl) warnings.push('已启用 CDP，但地址为空。');
  if (enabled && cdpUrl && !bin) {
    warnings.push('chrome-devtools-mcp 未安装，已跳过 CDP 配置；请在后台点“安装/更新 MCP”。');
  }

  if (!enabled || !cdpUrl || !bin) {
    try {
      removeClaude(removed);
    } catch (err) {
      warnings.push(`清理 Claude MCP 配置失败: ${err.message}`);
    }
    try {
      await removeCodex(removed);
    } catch (err) {
      warnings.push(`清理 Codex MCP 配置失败: ${err.message}`);
    }
    try {
      removeOpenCode(removed);
    } catch (err) {
      warnings.push(`清理 OpenCode MCP 配置失败: ${err.message}`);
    }
    try {
      removePi(removed);
    } catch (err) {
      warnings.push(`清理 Pi MCP 配置失败: ${err.message}`);
    }
    return { enabled, cdpUrl, written, removed, warnings };
  }

  try {
    writeClaude(cdpUrl, bin, written);
  } catch (err) {
    warnings.push(`写入 Claude MCP 配置失败: ${err.message}`);
  }
  try {
    await writeCodex(cdpUrl, bin, written);
  } catch (err) {
    warnings.push(`写入 Codex MCP 配置失败: ${err.message}`);
  }
  try {
    writeOpenCode(cdpUrl, bin, written);
  } catch (err) {
    warnings.push(`写入 OpenCode MCP 配置失败: ${err.message}`);
  }
  try {
    writePi(cdpUrl, bin, written);
  } catch (err) {
    warnings.push(`写入 Pi MCP 配置失败: ${err.message}`);
  }

  return { enabled, cdpUrl, written, removed, warnings };
}

function findT3Chrome() {
  const root = path.join(os.homedir(), '.t3', 'tools', 'chrome-headless-shell');
  if (!fs.existsSync(root)) return null;

  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (depth > 5) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && (entry.name === 'chrome-headless-shell' || entry.name === 'chrome')) {
        return full;
      }
      if (entry.isDirectory()) queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return null;
}

let t3BrowserCache = { at: 0, value: null };

export function t3BrowserState() {
  if (t3BrowserCache.value && Date.now() - t3BrowserCache.at < T3_BROWSER_TTL_MS) {
    return t3BrowserCache.value;
  }

  let fonts = false;
  try {
    const family = execFileSync('fc-match', ['-f', '%{family}'], {
      timeout: 2000,
      encoding: 'utf8',
    });
    fonts = Boolean(family.trim());
  } catch {
    fonts = false;
  }

  const chrome = findT3Chrome();
  const value = {
    sandboxDisabled: process.env.T3CODE_SERVER_BROWSER_SANDBOX === '0',
    fonts,
    chromeInstalled: Boolean(chrome),
    chromePath: chrome,
  };
  t3BrowserCache = { at: Date.now(), value };
  return value;
}

export async function browserSnapshot(browser) {
  const cdpUrl = String(browser?.cdpUrl || '');
  const [probe, mcp] = await Promise.all([probeCdp(cdpUrl), mcpInfo()]);
  return {
    enabled: browser?.enabled !== false,
    cdpUrl,
    probe,
    mcp,
    agents: configuredAgents(),
    t3Browser: t3BrowserState(),
  };
}
