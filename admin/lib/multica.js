import { spawn } from 'node:child_process';

const BIN = process.env.MULTICA_BIN || 'multica';

function run(args, { timeout = 60000, env = {} } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(BIN, args, {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: 1, stdout: '', stderr: '', error: err.message });
      return;
    }

    let stdout = '';
    let stderr = '';
    let done = false;
    let timedOut = false;

    const finish = (code, error = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, error });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出
      }
    }, timeout);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (timedOut) return;
      finish(1, err.message);
    });
    child.on('close', (code) => {
      finish(typeof code === 'number' ? code : 1, timedOut ? 'timeout' : '');
    });
  });
}

export async function version() {
  return run(['--version'], { timeout: 15000 });
}

export async function authStatus() {
  return run(['auth', 'status'], { timeout: 20000 });
}

export async function daemonStatus() {
  return run(['daemon', 'status'], { timeout: 20000 });
}

export async function login(token) {
  return run(['login', `--token=${token}`], { timeout: 60000 });
}

export async function configure(config, { forceLogin = false } = {}) {
  const steps = [];

  if (config.serverUrl) {
    const result = await run(['config', 'set', 'server_url', config.serverUrl], { timeout: 30000 });
    steps.push({ step: 'server_url', ...result });
  }
  if (config.appUrl) {
    const result = await run(['config', 'set', 'app_url', config.appUrl], { timeout: 30000 });
    steps.push({ step: 'app_url', ...result });
  }

  if (config.token) {
    if (!forceLogin) {
      const status = await authStatus();
      if (status.code === 0) {
        steps.push({ step: 'auth', code: 0, stdout: '已登录，跳过 token 登录', stderr: '' });
        return steps;
      }
    }
    const result = await login(config.token);
    steps.push({ step: 'login', ...result });
  }

  return steps;
}

export async function installCli() {
  return new Promise((resolve) => {
    const script = 'curl -fsSL https://raw.githubusercontent.com/multica-ai/multica/main/scripts/install.sh | bash';
    const child = spawn('bash', ['-lc', script], {
      env: { ...process.env, MULTICA_BIN_DIR: '/opt/agents/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code, error = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, error });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出
      }
    }, 300000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => finish(1, err.message));
    child.on('close', (code) => finish(typeof code === 'number' ? code : 1, ''));
  });
}