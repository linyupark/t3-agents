import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || '/root/.agent-hub';
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const DEFAULT_CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:16002';

const EMPTY_SETTINGS = {
  models: { profiles: [], assignments: {} },
  multica: {},
  browser: { enabled: true, cdpUrl: DEFAULT_CDP_URL },
};

export function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeFileAtomic(file, text, mode = 0o600) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

export function writeJson(file, value, mode = 0o600) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function loadSettings() {
  const raw = readJson(SETTINGS_FILE, null);
  if (!raw || typeof raw !== 'object') return structuredClone(EMPTY_SETTINGS);
  return {
    models: {
      profiles: Array.isArray(raw.models?.profiles) ? raw.models.profiles : [],
      assignments: raw.models?.assignments && typeof raw.models.assignments === 'object'
        ? raw.models.assignments
        : {},
    },
    multica: raw.multica && typeof raw.multica === 'object' ? raw.multica : {},
    browser: {
      enabled: raw.browser?.enabled !== false,
      cdpUrl: typeof raw.browser?.cdpUrl === 'string' ? raw.browser.cdpUrl : DEFAULT_CDP_URL,
    },
  };
}

export function saveSettings(settings) {
  writeJson(SETTINGS_FILE, settings);
}

export function adminToken() {
  const fromEnv = String(process.env.ADMIN_TOKEN || '').trim();
  if (fromEnv) return fromEnv;

  const file = path.join(DATA_DIR, 'admin-token');
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    if (token) return token;
  } catch {
    // 首次启动，下面生成
  }

  const token = crypto.randomBytes(18).toString('base64url');
  writeFileAtomic(file, `${token}\n`);
  return token;
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}