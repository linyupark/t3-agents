import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJson } from './store.js';

// T3 Code 自己的用户设置（不是 Agent Hub 的 settings.json）。
// T3 从 $T3CODE_HOME/userdata/settings.json 读取 providerInstances；
// 这里只维护 claudeAgent 的 customModels：T3 的 Claude 选择器不会从
// ANTHROPIC_MODEL 之外推断模型，必须把额外模型写进这个字段。
export function t3SettingsFile() {
  const explicit = String(process.env.T3CODE_HOME || '').trim();
  const base = explicit || path.join(os.homedir(), '.t3');
  return path.join(base, 'userdata', 'settings.json');
}

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function effortDescriptor(efforts) {
  const fallback = efforts.includes('high') ? 'high' : efforts[0];
  return {
    id: 'effort',
    label: 'Reasoning',
    type: 'select',
    options: efforts.map((id) => ({
      id,
      label: EFFORT_LABELS[id] || id,
      ...(id === fallback ? { isDefault: true } : {}),
    })),
  };
}

// 网关的 /v1/models 会给出 reasoning_efforts。拿到真实等级可以避免把上游
// 不支持的 effort 传给 Claude Code；取不到时按常见值兜底。
async function fetchGatewayModels(profile) {
  const base = String(profile?.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base || !profile?.apiKey) return new Map();
  try {
    const response = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${profile.apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return new Map();
    const doc = await response.json();
    const list = Array.isArray(doc?.data) ? doc.data : Array.isArray(doc?.models) ? doc.models : [];
    const map = new Map();
    for (const item of list) {
      const id = String(item?.id || item?.slug || '').trim();
      if (id) map.set(id, item);
    }
    return map;
  } catch {
    return new Map();
  }
}

function effortsForModel(meta) {
  if (!meta) return ['low', 'high', 'max'];
  if (meta.supports_reasoning === false) return [];
  const listed = Array.isArray(meta.reasoning_efforts)
    ? meta.reasoning_efforts.filter((value) => CLAUDE_EFFORTS.includes(value))
    : [];
  return listed.length ? listed : ['low', 'high', 'max'];
}

function claudeTargets(models) {
  const profileId = models?.assignments?.claude;
  const profile = (models?.profiles || []).find((item) => item.id === profileId) || null;
  const usable = profile && (profile.protocol === 'anthropic' || profile.protocol === 'both');
  if (!usable) return { profile: null, targets: [] };
  const targets = Array.isArray(profile.models) && profile.models.length
    ? profile.models
    : [profile.defaultModel, profile.fastModel].filter(Boolean).map((id) => ({ id }));
  return { profile, targets };
}

// 把 Agent Hub 里分配给 Claude 的模型写进 T3 的设置。
// T3 的 customModels 由 Agent Hub 独占管理：每次按当前配置整体替换，
// 取消 Claude 分配时会清空，避免残留旧模型。
export async function applyT3ClaudeModels(models) {
  const file = t3SettingsFile();
  const { profile, targets } = claudeTargets(models);
  const gateway = targets.length ? await fetchGatewayModels(profile) : new Map();
  const customModels = targets.map((model) => {
    const entry = { slug: model.id, name: model.name || model.id };
    if (model.reasoning) {
      const efforts = effortsForModel(gateway.get(model.id));
      if (efforts.length) {
        entry.capabilities = { optionDescriptors: [effortDescriptor(efforts)] };
      }
    }
    return entry;
  });

  let doc = readJson(file, null);
  if (!isRecord(doc)) {
    // 文件不存在（T3 首次启动前）可以新建；存在但解析失败时不能覆盖用户设置。
    if (fs.existsSync(file)) {
      return {
        written: false,
        file,
        slugs: [],
        warning: `无法解析 T3 设置文件 ${file}，Claude 的额外模型不会出现在 T3 选择器里。`,
      };
    }
    if (!customModels.length) return { written: false, file, slugs: [] };
    doc = {};
  }

  const instances = isRecord(doc.providerInstances) ? doc.providerInstances : {};
  const current = isRecord(instances.claudeAgent) ? instances.claudeAgent : null;
  const currentModels = Array.isArray(current?.config?.customModels) ? current.config.customModels : [];

  // 没有 Claude 分配、T3 里也没有我们写过的模型时，不碰 T3 的设置文件。
  if (!customModels.length && !currentModels.length) {
    return { written: false, file, slugs: [] };
  }

  const instance = { ...(current || {}), driver: current?.driver || 'claudeAgent' };
  const config = { ...(current?.config || {}) };
  if (customModels.length) config.customModels = customModels;
  else delete config.customModels;
  if (Object.keys(config).length) instance.config = config;
  else delete instance.config;
  instances.claudeAgent = instance;
  doc.providerInstances = instances;

  if (JSON.stringify(currentModels) === JSON.stringify(customModels)) {
    return { written: false, file, slugs: customModels.map((model) => model.slug) };
  }

  writeJson(file, doc, 0o600);
  return { written: true, file, slugs: customModels.map((model) => model.slug) };
}
