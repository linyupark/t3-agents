import { execFile } from 'node:child_process';

const PREFIX = process.env.NPM_CONFIG_PREFIX || '/opt/agents';
const REGISTRY = process.env.NPM_REGISTRY || '';
const LATEST_TTL = 10 * 60 * 1000;

export const AGENTS = [
  { key: 't3', name: 'T3 Code', pkg: 't3', bin: 't3', npm: true, restartAfterUpdate: true },
  { key: 'claude', name: 'Claude Code', pkg: '@anthropic-ai/claude-code', bin: 'claude', npm: true },
  { key: 'codex', name: 'Codex CLI', pkg: '@openai/codex', bin: 'codex', npm: true },
  { key: 'opencode', name: 'OpenCode', pkg: '@opencode/cli', bin: 'opencode', npm: true },
  {
    key: 'pi',
    name: 'Pi',
    pkg: '@earendil-works/pi-coding-agent',
    bin: 'pi',
    npm: true,
    npmArgs: ['--ignore-scripts'],
  },
  {
    key: 'cdp',
    name: 'Chrome DevTools MCP',
    pkg: 'chrome-devtools-mcp',
    bin: 'chrome-devtools-mcp',
    npm: true,
  },
];

const latestCache = new Map();
let updateLock = Promise.resolve();

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
          killed: Boolean(err?.killed),
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

function npmArgs(args) {
  const out = [...args];
  if (REGISTRY) out.push('--registry', REGISTRY);
  return out;
}

async function npmInstalledVersion(pkg) {
  const result = await run(
    'npm',
    npmArgs(['ls', '-g', '--prefix', PREFIX, '--json', pkg]),
    { timeout: 20000 },
  );
  try {
    const doc = JSON.parse(result.stdout || '{}');
    return doc.dependencies?.[pkg]?.version ?? null;
  } catch {
    return null;
  }
}

async function binaryVersion(bin) {
  const result = await run(bin, ['--version'], { timeout: 10000 });
  return parseVersion(`${result.stdout}\n${result.stderr}`);
}

async function latestVersion(pkg) {
  if (!pkg) return null;
  const cached = latestCache.get(pkg);
  if (cached && Date.now() - cached.at < LATEST_TTL) return cached.version;

  const result = await run('npm', npmArgs(['view', pkg, 'version', '--json']), {
    timeout: 25000,
  });
  let version = null;
  try {
    version = JSON.parse(result.stdout.trim() || 'null');
  } catch {
    version = parseVersion(result.stdout);
  }
  if (typeof version !== 'string') version = null;
  latestCache.set(pkg, { version, at: Date.now() });
  return version;
}

export async function listAgents() {
  const rows = await Promise.all(
    AGENTS.map(async (agent) => {
      const [installed, latest] = await Promise.all([
        agent.npm ? npmInstalledVersion(agent.pkg) : binaryVersion(agent.bin),
        latestVersion(agent.pkg),
      ]);
      return {
        key: agent.key,
        name: agent.name,
        package: agent.pkg || null,
        binary: agent.bin,
        installed: installed || (await binaryVersion(agent.bin)),
        latest,
        canUpdate: Boolean(agent.pkg),
      };
    }),
  );
  return rows;
}

function findAgent(key) {
  return AGENTS.find((agent) => agent.key === key) || null;
}

async function doUpdate(agent) {
  if (agent.npm) {
    const args = [
      'install',
      '-g',
      '--prefix',
      PREFIX,
      '--no-fund',
      '--no-audit',
      `${agent.pkg}@latest`,
      ...(agent.npmArgs || []),
    ];
    const result = await run('npm', npmArgs(args), { timeout: 300000 });
    latestCache.delete(agent.pkg);
    return {
      ok: result.code === 0,
      output: [result.stdout, result.stderr, result.error].filter(Boolean).join('\n').trim(),
    };
  }

  return { ok: false, output: `不支持更新 ${agent.key}` };
}

export function updateAgent(key) {
  const agent = findAgent(key);
  if (!agent) return Promise.resolve({ ok: false, output: '未知 agent' });

  const task = updateLock.then(() => doUpdate(agent), () => doUpdate(agent));
  updateLock = task.catch(() => {});
  return task;
}