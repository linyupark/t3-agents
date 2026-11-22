import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { readJson, writeFileAtomic, writeJson } from './store.js';

export const AGENT_KEYS = ['claude', 'codex', 'opencode', 'pi'];

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MODEL_RE = /^[A-Za-z0-9._:/@+-]{1,160}$/;

function fail(message) {
  throw new Error(message);
}

export function normalizeModels(input) {
  const rawProfiles = Array.isArray(input?.profiles) ? input.profiles : [];
  const profiles = [];
  const seen = new Set();

  for (const raw of rawProfiles) {
    const profile = {
      id: String(raw?.id || '').trim(),
      name: String(raw?.name || '').trim() || '未命名配置',
      protocol: raw?.protocol === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: String(raw?.baseUrl || '').trim().replace(/\/+$/, ''),
      apiKey: String(raw?.apiKey || '').trim(),
      defaultModel: String(raw?.defaultModel || '').trim(),
      fastModel: String(raw?.fastModel || '').trim(),
      openaiApi: raw?.openaiApi === 'chat' ? 'chat' : 'responses',
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
    if (!MODEL_RE.test(profile.defaultModel)) fail(`配置 ${profile.id} 的默认模型 ID 不合法`);
    if (profile.fastModel && !MODEL_RE.test(profile.fastModel)) fail(`配置 ${profile.id} 的快速模型 ID 不合法`);

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
    ];
    settings.env = settings.env && typeof settings.env === 'object' ? settings.env : {};
    const profile = assigned('claude');
    const usable = profile?.protocol === 'anthropic';

    if (profile && !usable) {
      warnings.push('Claude Code 只能使用 Anthropic 兼容端点；当前分配的是 OpenAI 协议配置，已跳过 claude。');
    }

    if (usable) {
      settings.env.ANTHROPIC_BASE_URL = profile.baseUrl;
      settings.env.ANTHROPIC_MODEL = profile.defaultModel;
      if (profile.apiKey) settings.env.ANTHROPIC_AUTH_TOKEN = profile.apiKey;
      else delete settings.env.ANTHROPIC_AUTH_TOKEN;
      if (profile.fastModel) settings.env.ANTHROPIC_SMALL_FAST_MODEL = profile.fastModel;
      else delete settings.env.ANTHROPIC_SMALL_FAST_MODEL;
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
    const profile = assigned('codex');
    const usable = profile?.protocol === 'openai' && profile?.openaiApi === 'responses';
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
    } else if (exists && doc.model_provider === 'agenthub') {
      delete doc.model_provider;
      if (doc.model_providers && typeof doc.model_providers === 'object') {
        delete doc.model_providers.agenthub;
        if (!Object.keys(doc.model_providers).length) delete doc.model_providers;
      }
      writeFileAtomic(file, `${stringifyToml(doc)}\n`, 0o600);
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

      doc.providers.agenthub = {
        name: profile.name,
        package: pkg,
        settings: {
          baseURL: profile.baseUrl,
          ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
        },
        models: {
          [profile.defaultModel]: { name: profile.defaultModel },
        },
      };
      doc.model = `agenthub/${profile.defaultModel}`;
      writeJson(file, doc, 0o600);
      written.push('~/.config/opencode/opencode.json');
    } else if (doc.providers.agenthub) {
      delete doc.providers.agenthub;
      if (typeof doc.model === 'string' && doc.model.startsWith('agenthub/')) delete doc.model;
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
        baseUrl: profile.baseUrl,
        api: profile.protocol === 'anthropic'
          ? 'anthropic-messages'
          : profile.openaiApi === 'chat'
            ? 'openai-completions'
            : 'openai-responses',
        ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
        models: [{ id: profile.defaultModel, name: profile.defaultModel }],
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