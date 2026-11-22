import { execFile } from 'node:child_process';

const RETRIES = 3;
const RETRY_DELAY_MS = 800;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 去掉 URL 末尾的标点。`t3 pair` 会打印
// `Pairing with HOST (http://127.0.0.1:3773).`，正则很容易把 `).` 一起带上。
function cleanUrl(value) {
  return String(value || '').replace(/[)\]}.,;:!?]+$/, '');
}

export function parsePairingOutput(text) {
  const raw = stripAnsi(text);
  let pairingUrl = null;
  let appLink = null;
  let token = null;
  let expires = null;

  for (const line of raw.split(/\r?\n/)) {
    // 日志行带 `[时间] [stdout]` 前缀，所以不能用 ^ 锚定。
    const pair = line.match(/(?:^|\s)Pairing URL:\s*(\S+)/i);
    if (pair) pairingUrl = cleanUrl(pair[1]);
    const app = line.match(/(?:^|\s)App link:\s*(\S+)/i);
    if (app) appLink = cleanUrl(app[1]);
    const tok = line.match(/(?:^|\s)Token:\s*(\S+)/i);
    if (tok) token = tok[1];
    const exp = line.match(/(?:^|\s)Expires:\s*(\S+)/i);
    if (exp) expires = exp[1];
  }

  const urls = Array.from(raw.matchAll(/(?:t3code|https?):\/\/[^\s"'<>]+/g), (match) => cleanUrl(match[0]));

  if (!pairingUrl) {
    // 没有明确的 `Pairing URL:` 行时，只认带 /pair 的链接，
    // 避免把 `Pairing with HOST (http://127.0.0.1:3773).` 里的空地址当配对链接；
    // 找不到就退到 t3code:// 深链。
    pairingUrl = urls.find((url) => /^https?:\/\//.test(url) && /\/pair(?:[?#]|$)/i.test(url)) || null;
  }
  if (!appLink) appLink = urls.find((url) => url.startsWith('t3code://')) || null;

  return {
    url: pairingUrl || appLink,
    pairingUrl,
    appLink,
    token,
    expires,
    urls,
  };
}

export async function pairing() {
  let last = { code: 1, url: null, appLink: null, token: null, expires: null, urls: [], output: '', error: '' };

  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    if (attempt) await sleep(RETRY_DELAY_MS * attempt);

    const result = await runT3(['pair'], { timeout: 30000 });
    const raw = stripAnsi(`${result.stdout}\n${result.stderr}`).trim();
    const parsed = parsePairingOutput(raw);
    last = {
      code: result.code,
      ...parsed,
      output: raw.slice(0, 6000),
      error: parsed.url ? '' : result.error,
    };

    if (parsed.url) return last;
    // 没解析到链接就重试：通常是 T3 刚重启、还没打印完整的配对信息。
  }

  if (!last.url) {
    last.error = last.error || '未从 t3 pair 输出中解析到配对链接';
  }
  return last;
}
