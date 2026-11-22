import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { ANTHROPIC_PROXY_URL, resolveAnthropicBase } from './anthropic-proxy.js';
import { readJson, writeFileAtomic, writeJson } from './store.js';

export const AGENT_KEYS = ['claude', 'codex', 'opencode', 'pi'];

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MODEL_RE = /^[A-Za-z0-9._:/@+-]{1,160}$/;

function fail(message) {
  throw new Error(message);
}

// 配置里的模型条目：id 是发给网关的真实模型 ID；name 只影响显示；
// vision 表示该模型接受图片输入，reasoning 表示它支持思考等级。
// 旧配置只有 defaultModel / fastModel，normalizeModels 会把它们补进列表。
function normalizeModelEntry(raw, profileId) {
  const id = String(raw?.id ?? raw ?? '').trim();
  if (!id) return null;
  if (!MODEL_RE.test(id)) fail(`配置 ${profileId} 的模型 ID 不合法: ${id}`);
  return {
    id,
    name: String(raw?.name || '').trim(),
    vision: raw?.vision === true,
    reasoning: raw?.reasoning === true,
  };
}

export function normalizeModels(input) {
  const rawProfiles = Array.isArray(input?.profiles) ? input.profiles : [];
  const profiles = [];
  const seen = new Set();

  for (const raw of rawProfiles) {
    const profile = {
      id: String(raw?.id || '').trim(),
      name: String(raw?.name || '').trim() || '未命名配置',
      protocol: raw?.protocol === 'anthropic' ? 'anthropic' : raw?.protocol === 'both' ? 'both' : 'openai',
      baseUrl: String(raw?.baseUrl || '').trim().replace(/\/+$/, ''),
      anthropicBaseUrl: String(raw?.anthropicBaseUrl || '').trim().replace(/\/+$/, ''),
      apiKey: String(raw?.apiKey || '').trim(),
      defaultModel: String(raw?.defaultModel || '').trim(),
      fastModel: String(raw?.fastModel || '').trim(),
      contextWindow: Number(raw?.contextWindow) > 0 ? Math.floor(Number(raw.contextWindow)) : 0,
      openaiApi: raw?.openaiApi === 'chat' ? 'chat' : 'responses',
      models: [],
    };

    if (!ID_RE.test(profile.id)) fail(`配置 ID 不合法: ${profile.id || '(空)'}（只允许小写字母、数字、-）`);
    if (seen.has(profile.id)) fail(`配置 ID 重复: ${profile.id}`);
    seen.add(profile.id);

    let parsed;
    try {
      parsed = new URL(profile.baseUrl);
    } catch {
      fail(`配置 ${profile.id} 的 baseUrl 不是合法 URL`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) fail(`配置 ${profile.id} 的 baseUrl 必须是 http/https`);
    if (profile.anthropicBaseUrl) {
      try {
        parsed = new URL(profile.anthropicBaseUrl);
      } catch {
        fail(`配置 ${profile.id} 的 anthropicBaseUrl 不是合法 URL`);
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        fail(`配置 ${profile.id} 的 anthropicBaseUrl 必须是 http/https`);
      }
    }
    if (!MODEL_RE.test(profile.defaultModel)) fail(`配置 ${profile.id} 的默认模型 ID 不合法`);
    if (profile.fastModel && !MODEL_RE.test(profile.fastModel)) fail(`配置 ${profile.id} 的快速模型 ID 不合法`);

    // 默认模型和快速模型始终写进列表；额外模型按顺序追加，重复 ID 合并。
    const addModel = (entry) => {
      if (!entry) return;
      const existing = profile.models.find((model) => model.id === entry.id);
      if (!existing) {
        profile.models.push(entry);
        return;
      }
      existing.vision = existing.vision || entry.vision;
      existing.reasoning = existing.reasoning || entry.reasoning;
      existing.name = existing.name || entry.name;
    };
    addModel(normalizeModelEntry({ id: profile.defaultModel }, profile.id));
    addModel(normalizeModelEntry({ id: profile.fastModel }, profile.id));
    for (const rawModel of Array.isArray(raw?.models) ? raw.models : []) {
      addModel(normalizeModelEntry(rawModel, profile.id));
    }

    profiles.push(profile);
  }

  const ids = new Set(profiles.map((profile) => profile.id));
  const assignments = {};
  for (const key of AGENT_KEYS) {
    const value = input?.assignments?.[key];
    assignments[key] = value && ids.has(value) ? value : null;
  }

  return { profiles, assignments };
}

export function redactModels(models) {
  return {
    assignments: { ...(models?.assignments || {}) },
    profiles: (models?.profiles || []).map(({ apiKey, ...rest }) => ({
      ...rest,
      hasApiKey: Boolean(apiKey),
    })),
  };
}

function backupOnce(file) {
  if (fs.existsSync(file) && !fs.existsSync(`${file}.bak`)) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
    } catch {
      // 备份失败不阻塞
    }
  }
}

function readJsonObject(file) {
  const value = readJson(file, {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// Claude Code / Anthropic SDK 会自己在 baseUrl 后追加 `/v1/messages`。
// 如果 baseUrl 写成 `.../v1`，请求会变成 `.../v1/v1/messages` 并 404。
export function anthropicBaseUrl(baseUrl) {
  return resolveAnthropicBase({ baseUrl });
}

// OpenCode / Pi / Codex 把模型暴露给 T3 的模型列表；默认、快速和额外模型
// 都要写进去，否则 T3 只能看到主模型。
function modelEntries(profile) {
  const source = Array.isArray(profile?.models) && profile.models.length
    ? profile.models
    : [profile?.defaultModel, profile?.fastModel].filter(Boolean).map((id) => ({ id }));
  const list = [];
  for (const entry of source) {
    const id = String(entry?.id || '').trim();
    if (!id || list.some((item) => item.id === id)) continue;
    list.push({
      id,
      name: String(entry?.name || '').trim(),
      vision: entry?.vision === true,
      reasoning: entry?.reasoning === true,
    });
  }
  return list;
}

function usesAgentHubModel(value) {
  if (typeof value === 'string') return value.startsWith('agenthub/');
  return Boolean(value && typeof value === 'object' && value.providerID === 'agenthub');
}

// Codex 的 model_catalog_json 要求每条模型都带完整的 instructions；直接手写很容易
// 缺字段导致整份目录被忽略。这里从 Codex 自带清单里取一条做模板，只替换模型相关字段。
let codexCatalogTemplateCache;
function codexCatalogTemplate() {
  if (codexCatalogTemplateCache !== undefined) return codexCatalogTemplateCache;
  try {
    const out = execFileSync(process.env.CODEX_BIN || 'codex', ['debug', 'models', '--bundled'], {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const doc = JSON.parse(out);
    const list = Array.isArray(doc?.models) ? doc.models : [];
    codexCatalogTemplateCache =
      list.find((item) => item?.visibility === 'list' && item?.base_instructions) ||
      list.find((item) => item?.base_instructions) ||
      null;
  } catch {
    codexCatalogTemplateCache = null;
  }
  return codexCatalogTemplateCache;
}

function codexCatalog(profile) {
  const template = codexCatalogTemplate();
  if (!template) return null;
  return {
    models: modelEntries(profile).map((model, index) => {
      const contextWindow = profile.contextWindow || 200000;
      return {
        ...template,
        slug: model.id,
        display_name: model.name || model.id,
        description: `Agent Hub: ${profile.name}`,
        context_window: contextWindow,
        max_context_window: contextWindow,
        input_modalities: model.vision ? ['text', 'image'] : ['text'],
        supports_image_detail_original: model.vision,
        visibility: 'list',
        supported_in_api: true,
        priority: index + 1,
        service_tiers: [],
        additional_speed_tiers: [],
        default_service_tier: null,
        upgrade: null,
        availability_nux: null,
        model_specialty: null,
      };
    }),
  };
}

export function applyModelConfig(models) {
  const home = os.homedir();
  const warnings = [];
  const written = [];
  const env = {};
  const byId = new Map((models?.profiles || []).map((profile) => [profile.id, profile]));
  const assigned = (key) => byId.get(models?.assignments?.[key]) || null;

  // ---------- Claude Code ----------
  try {
    const file = path.join(home, '.claude', 'settings.json');
    const settings = readJsonObject(file);
    const managed = [
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL',
      'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
    ];
    settings.env = settings.env && typeof settings.env === 'object' ? settings.env : {};
    const profile = assigned('claude');
    const usable = profile && (profile.protocol === 'anthropic' || profile.protocol === 'both');

    if (profile && !usable) {
      warnings.push('Claude Code 只能使用 Anthropic 兼容端点；当前分配的是 OpenAI-only 配置，已跳过 claude。');
    }

    if (usable) {
      const upstream = resolveAnthropicBase(profile);
      if (upstream !== profile.baseUrl) {
        warnings.push(
          `Claude Code 会在 baseUrl 后追加 /v1/messages；Anthropic 端点使用 ${upstream}。`,
        );
      }
      const proxyEnabled = process.env.CLAUDE_PROXY !== '0';
      settings.env.ANTHROPIC_BASE_URL = proxyEnabled ? ANTHROPIC_PROXY_URL : upstream;
      if (proxyEnabled) {
        warnings.push(
          `Claude Code 请求会经本机代理 ${ANTHROPIC_PROXY_URL} 转发到 ${upstream}，自动去掉上游不接受的 x-anthropic-billing-header。`,
        );
      }
      settings.env.ANTHROPIC_MODEL = profile.defaultModel;
      if (profile.apiKey) settings.env.ANTHROPIC_AUTH_TOKEN = profile.apiKey;
      else delete settings.env.ANTHROPIC_AUTH_TOKEN;
      if (profile.fastModel) settings.env.ANTHROPIC_SMALL_FAST_MODEL = profile.fastModel;
      else delete settings.env.ANTHROPIC_SMALL_FAST_MODEL;
      // 自定义模型 ID 不在 Claude Code 的内置清单里；显式声明窗口，避免它按 1M 猜测。
      if (profile.contextWindow) settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(profile.contextWindow);
      else delete settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
      settings.__agentHub = { ...(settings.__agentHub || {}), claudeProfile: profile.id };
      writeJson(file, settings, 0o600);
      written.push('~/.claude/settings.json');
    } else if (settings.__agentHub?.claudeProfile) {
      for (const key of managed) delete settings.env[key];
      delete settings.__agentHub.claudeProfile;
      if (!Object.keys(settings.__agentHub).length) delete settings.__agentHub;
      writeJson(file, settings, 0o600);
      written.push('~/.claude/settings.json');
    }
  } catch (err) {
    warnings.push(`写入 Claude Code 配置失败: ${err.message}`);
  }

  // ---------- Codex ----------
  try {
    const file = path.join(home, '.codex', 'config.toml');
    const catalogFile = path.join(home, '.codex', 'agenthub-models.json');
    const catalogRef = '~/.codex/agenthub-models.json';
    const profile = assigned('codex');
    const usable = profile && profile.protocol !== 'anthropic' && profile.openaiApi === 'responses';
    let doc = {};
    let exists = false;

    if (fs.existsSync(file)) {
      exists = true;
      try {
        doc = parseToml(fs.readFileSync(file, 'utf8'));
      } catch {
        backupOnce(file);
        warnings.push('~/.codex/config.toml 解析失败，已备份为 config.toml.bak 并重新生成。');
        doc = {};
      }
    }

    if (profile && !usable) {
      warnings.push('Codex 当前只支持 OpenAI Responses 协议；请选择 OpenAI 协议 + Responses，已跳过 codex。');
    }

    if (usable) {
      // Codex 的模型选择器来自 app-server 的 model/list；只写 config.toml 的 model
      // 不会让自定义模型出现在列表里。model_catalog_json 可以补上自定义模型和名称。
      const catalog = codexCatalog(profile);
      if (catalog) {
        writeJson(catalogFile, catalog, 0o600);
        doc.model_catalog_json = catalogRef;
        written.push('~/.codex/agenthub-models.json');
      } else {
        delete doc.model_catalog_json;
        warnings.push('无法从 `codex debug models` 生成自定义模型目录，Codex 选择器里可能看不到配置的模型。');
      }
      doc.model = profile.defaultModel;
      doc.model_provider = 'agenthub';
      doc.model_providers = doc.model_providers && typeof doc.model_providers === 'object'
        ? doc.model_providers
        : {};
      doc.model_providers.agenthub = {
        name: profile.name,
        base_url: profile.baseUrl,
        env_key: 'AGENT_HUB_CODEX_KEY',
        wire_api: 'responses',
      };
      backupOnce(file);
      writeFileAtomic(file, `${stringifyToml(doc)}\n`, 0o600);
      env.AGENT_HUB_CODEX_KEY = profile.apiKey;
      written.push('~/.codex/config.toml');
    } else if (exists && (doc.model_provider === 'agenthub' || doc.model_catalog_json === catalogRef)) {
      if (doc.model_provider === 'agenthub') {
        delete doc.model_provider;
        delete doc.model;
        if (doc.model_providers && typeof doc.model_providers === 'object') {
          delete doc.model_providers.agenthub;
          if (!Object.keys(doc.model_providers).length) delete doc.model_providers;
        }
      }
      if (doc.model_catalog_json === catalogRef) delete doc.model_catalog_json;
      writeFileAtomic(file, `${stringifyToml(doc)}\n`, 0o600);
      try {
        fs.rmSync(catalogFile, { force: true });
      } catch {
        // 删不掉不影响主流程
      }
      written.push('~/.codex/config.toml');
    }
  } catch (err) {
    warnings.push(`写入 Codex 配置失败: ${err.message}`);
  }

  // ---------- OpenCode ----------
  try {
    const file = path.join(home, '.config', 'opencode', 'opencode.json');
    const doc = readJsonObject(file);
    doc.$schema = doc.$schema || 'https://opencode.ai/config.json';
    doc.providers = doc.providers && typeof doc.providers === 'object' ? doc.providers : {};
    const profile = assigned('opencode');

    if (profile) {
      const pkg = profile.protocol === 'anthropic'
        ? '@opencode/ai/providers/anthropic-compatible'
        : profile.openaiApi === 'chat'
          ? '@opencode/ai/providers/openai-compatible'
          : '@opencode/ai/providers/openai-compatible/responses';

      const entries = modelEntries(profile);
      doc.providers.agenthub = {
        name: profile.name,
        package: pkg,
        settings: {
          baseURL: profile.protocol === 'anthropic' ? resolveAnthropicBase(profile) : profile.baseUrl,
          ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
        },
        models: Object.fromEntries(entries.map((model) => [
          model.id,
          {
            name: model.name || model.id,
            // OpenCode 用 capabilities.input 判断模型能否接收图片；不写则按纯文本处理。
            ...(model.vision ? { capabilities: { input: ['text', 'image'] } } : {}),
          },
        ])),
      };
      doc.model = `agenthub/${profile.defaultModel}`;
      if (profile.fastModel && profile.fastModel !== profile.defaultModel) {
        doc.small_model = `agenthub/${profile.fastModel}`;
      } else if (usesAgentHubModel(doc.small_model)) {
        delete doc.small_model;
      }
      writeJson(file, doc, 0o600);
      written.push('~/.config/opencode/opencode.json');
    } else if (doc.providers.agenthub) {
      delete doc.providers.agenthub;
      if (usesAgentHubModel(doc.model)) delete doc.model;
      if (usesAgentHubModel(doc.small_model)) delete doc.small_model;
      writeJson(file, doc, 0o600);
      written.push('~/.config/opencode/opencode.json');
    }
  } catch (err) {
    warnings.push(`写入 OpenCode 配置失败: ${err.message}`);
  }

  // ---------- Pi ----------
  try {
    const dir = path.join(home, '.pi', 'agent');
    const modelsFile = path.join(dir, 'models.json');
    const settingsFile = path.join(dir, 'settings.json');
    const modelsDoc = readJsonObject(modelsFile);
    const settingsDoc = readJsonObject(settingsFile);
    modelsDoc.$schema = modelsDoc.$schema || 'https://pi.dev/schemas/models.schema.json';
    modelsDoc.providers = modelsDoc.providers && typeof modelsDoc.providers === 'object'
      ? modelsDoc.providers
      : {};
    const profile = assigned('pi');

    if (profile) {
      modelsDoc.providers.agenthub = {
        name: profile.name,
        baseUrl: profile.protocol === 'anthropic' ? resolveAnthropicBase(profile) : profile.baseUrl,
        api: profile.protocol === 'anthropic'
          ? 'anthropic-messages'
          : profile.openaiApi === 'chat'
            ? 'openai-completions'
            : 'openai-responses',
        ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
        models: modelEntries(profile).map((model) => ({
          id: model.id,
          name: model.name || model.id,
          // Pi 的自定义模型默认按纯文本处理；显式写 image 才会把图片传给模型。
          ...(model.vision ? { input: ['text', 'image'] } : {}),
          // T3 的 Pi 驱动只有在模型声明 reasoning 时才显示思考等级选择。
          ...(model.reasoning ? { reasoning: true } : {}),
        })),
      };
      writeJson(modelsFile, modelsDoc, 0o600);
      settingsDoc.$schema = settingsDoc.$schema || 'https://pi.dev/schemas/settings.schema.json';
      settingsDoc.defaultProvider = 'agenthub';
      settingsDoc.defaultModel = profile.defaultModel;
      writeJson(settingsFile, settingsDoc, 0o600);
      written.push('~/.pi/agent/models.json', '~/.pi/agent/settings.json');
    } else if (modelsDoc.providers.agenthub) {
      delete modelsDoc.providers.agenthub;
      writeJson(modelsFile, modelsDoc, 0o600);
      if (settingsDoc.defaultProvider === 'agenthub') {
        delete settingsDoc.defaultProvider;
        delete settingsDoc.defaultModel;
        writeJson(settingsFile, settingsDoc, 0o600);
      }
      written.push('~/.pi/agent/models.json');
    }
  } catch (err) {
    warnings.push(`写入 Pi 配置失败: ${err.message}`);
  }

  return { warnings, written, env };
}