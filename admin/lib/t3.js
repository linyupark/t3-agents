import { execFile } from 'node:child_process';

function runT3(args, { timeout = 30000, cwd = '/workspace' } = {}) {
  return new Promise((resolve) => {
    execFile(
      't3',
      args,
      { timeout, cwd, maxBuffer: 4 * 1024 * 1024, env: process.env },
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

export function stripAnsi(text) {
  return String(text).replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

export async function pairing() {
  const result = await runT3(['pair'], { timeout: 30000 });
  const raw = stripAnsi(`${result.stdout}\n${result.stderr}`).trim();

  const urls = raw.match(/(?:t3code|https?):\/\/[^\s"'<>]+/g) || [];
  const appLink = urls.find((url) => url.startsWith('t3code://')) || null;
  const url = urls.find((url) => url.startsWith('http://') || url.startsWith('https://')) || appLink;

  return {
    code: result.code,
    url,
    appLink,
    urls,
    output: raw.slice(0, 6000),
    error: result.error || (urls.length ? '' : '未从 t3 pair 输出中解析到配对链接'),
  };
}