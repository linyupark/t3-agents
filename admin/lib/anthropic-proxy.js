import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

// Claude Code 会在 system 数组里塞一个 `x-anthropic-billing-header: ...` 块。
// 对第三方 baseUrl，这个块的值是空的；部分网关（例如 llms.zj-qq.cn）会直接
// 返回 400 `Illegal API invocation from an unapproved channel`。
// 这里把转发逻辑挂在管理后台自己的 HTTP 服务上（同一端口、同一进程），
// 去掉该块后再转发给真正的上游，不再单独监听一个端口。

// 代理挂在管理后台的路径前缀。Claude Code 会在 baseUrl 后追加 `/v1/messages`，
// 所以 ANTHROPIC_BASE_URL 类似 `http://127.0.0.1:3774/anthropic-proxy`。
export const ANTHROPIC_PROXY_PATH = '/anthropic-proxy';

const BILLING_PREFIX = 'x-anthropic-billing-header:';

function loopbackHost(bind) {
  const value = String(bind || '').trim();
  if (!value || value === '0.0.0.0' || value === '::' || value === '[::]') return '127.0.0.1';
  if (value.includes(':') && !value.startsWith('[')) return `[${value}]`;
  return value;
}

export function anthropicProxyUrl({
  port = process.env.ADMIN_PORT || '3774',
  bind = process.env.ADMIN_BIND || '0.0.0.0',
} = {}) {
  return `http://${loopbackHost(bind)}:${port}${ANTHROPIC_PROXY_PATH}`;
}

// 运行时只有一份后台进程，启动时按环境变量算一次即可。
export const ANTHROPIC_PROXY_URL = anthropicProxyUrl();

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

// Claude Code 用 ANTHROPIC_AUTH_TOKEN 时发 `Authorization: Bearer`，用
// ANTHROPIC_API_KEY 时发 `x-api-key`。代理和管理后台共用端口，必须确认调用方
// 拿的就是分配给 Claude 的那把 key，否则任何能访问 3774 的人都能白嫖上游。
function presentedToken(headers) {
  const apiKey = headers.get('x-api-key');
  if (apiKey) return apiKey.trim();
  const match = /^Bearer\s+(.+)$/i.exec(headers.get('authorization') || '');
  return match ? match[1].trim() : '';
}

function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: { message, type: 'invalid_request_error' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export class AnthropicProxy {
  constructor({ url = ANTHROPIC_PROXY_URL, prefix = ANTHROPIC_PROXY_PATH } = {}) {
    this.url = url;
    this.prefix = prefix;
    this.target = null;
    this.apiKey = '';
  }

  // 只代理被分配到 Claude 的 anthropic / both 配置。
  configure(models) {
    const id = models?.assignments?.claude;
    const profile = (models?.profiles || []).find((item) => item.id === id);
    const usable = profile && (profile.protocol === 'anthropic' || profile.protocol === 'both');
    this.target = usable ? resolveAnthropicBase(profile) : null;
    this.apiKey = usable ? String(profile.apiKey || '').trim() : '';
  }

  // Hono 处理器：把 `/anthropic-proxy/**` 原样转发到 Anthropic 上游。
  async handle(c) {
    if (!this.target) return errorResponse(503, 'No Anthropic profile assigned to Claude Code.');

    const expected = this.apiKey;
    if (expected && presentedToken(c.req.raw.headers) !== expected) {
      return errorResponse(401, 'Invalid credentials for the Agent Hub Anthropic proxy.');
    }

    const requestUrl = new URL(c.req.url);
    const prefix = this.prefix;
    const suffix = requestUrl.pathname.startsWith(prefix)
      ? requestUrl.pathname.slice(prefix.length) || '/'
      : requestUrl.pathname;

    let target;
    try {
      target = new URL(this.target);
    } catch {
      return errorResponse(502, 'Anthropic proxy target is not a valid URL.');
    }
    target.pathname = `${target.pathname.replace(/\/+$/, '')}${suffix}`;
    target.search = requestUrl.search;

    let body = Buffer.from(await c.req.arrayBuffer());
    if (/^\/v1\/messages(\/count_tokens)?(\?|$)/.test(`${suffix}${requestUrl.search}`) && body.length) {
      body = stripBillingHeader(body);
    }

    const headers = {};
    for (const [key, value] of c.req.raw.headers) {
      if (key === 'host' || key === 'connection' || key === 'content-length') continue;
      headers[key] = value;
    }
    headers.host = target.host;
    if (body.length) headers['content-length'] = String(body.length);
    else delete headers['content-length'];

    const transport = target.protocol === 'https:' ? https : http;
    let upstream;
    try {
      upstream = await new Promise((resolve, reject) => {
        const req = transport.request(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: `${target.pathname}${target.search}`,
            method: c.req.method,
            headers,
          },
          resolve,
        );
        req.on('error', reject);
        c.req.raw.signal?.addEventListener('abort', () => req.destroy(), { once: true });
        req.end(body.length ? body : undefined);
      });
    } catch (err) {
      return errorResponse(502, `Anthropic proxy error: ${err.message}`);
    }

    // 逐字节转发上游响应，保持 SSE 流式输出；只去掉逐跳头。
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(upstream.headers)) {
      if (value === undefined) continue;
      if (['connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(key)) continue;
      if (Array.isArray(value)) {
        for (const item of value) responseHeaders.append(key, item);
      } else {
        responseHeaders.set(key, value);
      }
    }

    return new Response(Readable.toWeb(upstream), {
      status: upstream.statusCode || 502,
      headers: responseHeaders,
    });
  }
}
