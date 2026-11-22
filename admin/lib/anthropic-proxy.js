import http from 'node:http';
import https from 'node:https';

// Claude Code 会在 system 数组里塞一个 `x-anthropic-billing-header: ...` 块。
// 对第三方 baseUrl，这个块的值是空的；部分网关（例如 llms.zj-qq.cn）会直接
// 返回 400 `Illegal API invocation from an unapproved channel`。
// 这里跑一个只监听本机的转发代理，把该块去掉后再转发给真正的上游。
export const ANTHROPIC_PROXY_PORT = Number(process.env.CLAUDE_PROXY_PORT || 3775);
export const ANTHROPIC_PROXY_URL = `http://127.0.0.1:${ANTHROPIC_PROXY_PORT}`;

const BILLING_PREFIX = 'x-anthropic-billing-header:';

// Anthropic 兼容端点：显式配置优先，否则去掉 OpenAI 端点末尾的 `/v1`
// （Claude Code 会自己追加 `/v1/messages`）。
export function resolveAnthropicBase(profile) {
  const explicit = String(profile?.anthropicBaseUrl || '').trim();
  if (explicit) return explicit.replace(/\/v1\/?$/i, '').replace(/\/+$/, '');
  return String(profile?.baseUrl || '')
    .trim()
    .replace(/\/v1\/?$/i, '')
    .replace(/\/+$/, '');
}

function stripBillingHeader(body) {
  let json;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }
  if (!json || !Array.isArray(json.system)) return body;
  const kept = json.system.filter(
    (block) => !(block && typeof block.text === 'string' && block.text.trimStart().startsWith(BILLING_PREFIX)),
  );
  if (kept.length === json.system.length) return body;
  return Buffer.from(JSON.stringify({ ...json, system: kept }));
}

export class AnthropicProxy {
  constructor({ host = '127.0.0.1', port = ANTHROPIC_PROXY_PORT } = {}) {
    this.host = host;
    this.port = port;
    this.url = `http://${host}:${port}`;
    this.target = null;
    this.server = null;
  }

  // 只代理被分配到 Claude 的 anthropic / both 配置。
  configure(models) {
    const id = models?.assignments?.claude;
    const profile = (models?.profiles || []).find((item) => item.id === id);
    const usable = profile && (profile.protocol === 'anthropic' || profile.protocol === 'both');
    this.target = usable ? resolveAnthropicBase(profile) : null;
  }

  start() {
    if (this.server) return;
    this.server = http.createServer((req, res) => this.#handle(req, res));
    this.server.on('error', (err) => {
      console.error(`[anthropic-proxy] ${err.message}`);
    });
    this.server.listen(this.port, this.host, () => {
      console.log(`[anthropic-proxy] listening on ${this.host}:${this.port}`);
    });
  }

  stop() {
    if (!this.server) return;
    this.server.close();
    this.server = null;
  }

  #handle(req, res) {
    if (!this.target) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'No Anthropic profile assigned to Claude Code.' } }));
      return;
    }

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if (/^\/v1\/messages(\/count_tokens)?(\?|$)/.test(req.url || '') && body.length) {
        body = stripBillingHeader(body);
      }

      const base = new URL(this.target);
      const basePath = base.pathname.replace(/\/+$/, '');
      const target = new URL(`${base.origin}${basePath}${req.url || '/'}`);
      const headers = { ...req.headers, host: base.host };
      delete headers.connection;
      if (body.length) headers['content-length'] = String(body.length);
      else delete headers['content-length'];

      const transport = target.protocol === 'https:' ? https : http;
      const upstream = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: req.method,
          headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      upstream.on('error', (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Anthropic proxy error: ${err.message}` } }));
        } else {
          res.end();
        }
      });
      upstream.end(body);
    });
  }
}
