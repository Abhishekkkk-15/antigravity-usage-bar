import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR =
  process.env.AGY_USAGE_CONFIG_DIR ||
  path.join(os.homedir(), '.config', 'antigravity-usage-bar');

export const INDEX_FILE = path.join(CONFIG_DIR, 'accounts.json');
export const FILE_STORE = path.join(CONFIG_DIR, 'tokens.json');
export const CACHE_FILE = path.join(CONFIG_DIR, 'usage-cache.json');
export const CACHE_LOCK_FILE = path.join(CONFIG_DIR, 'usage-cache.lock');

const LOCK_STALE_MS = 10 * 1000;
const LOCK_WAIT_MS = 15 * 1000;

let warnHandler = (message) => process.stderr.write(`warn: ${message}\n`);
let infoHandler = () => {};

export function setLogger({ onWarn, onInfo } = {}) {
  if (onWarn) warnHandler = onWarn;
  if (onInfo) infoHandler = onInfo;
}

export function warn(message) {
  warnHandler(message);
}

export function info(message) {
  infoHandler(message);
}

export function compact(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, v]) => v !== undefined && v !== null)
  );
}

const SECRET_PATTERNS = [
  /AIzaSy[A-Za-z0-9_-]{20,}/g, // Google API keys
  /ya29\.[A-Za-z0-9_-]{10,}/g, // Google OAuth Access Tokens
  /1\/\/[A-Za-z0-9_-]{10,}/g, // Google OAuth Refresh Tokens
  /\bsk-[A-Za-z0-9._-]{16,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\b(?:eyJ[A-Za-z0-9._-]{10,})/g,
  /\b(?:access|refresh|id)[_-]?token"?\s*[:=]\s*"?[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\bcode_verifier"?\s*[:=]\s*"?[A-Za-z0-9._~-]{8,}/gi,
];

export function redact(text) {
  if (text === null || text === undefined) return text;
  let out = String(text);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

export function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return email;
  const [user, domain] = email.split('@');
  const dot = domain.lastIndexOf('.');
  const tld = dot === -1 ? '' : domain.slice(dot);
  return `${user.slice(0, 1)}${'*'.repeat(Math.max(1, user.length - 1))}@${domain.slice(0, 1)}***${tld}`;
}

export function scrub(text) {
  return redact(text).replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    (match) => maskEmail(match)
  );
}

export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    if (
      /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Extended_Pictographic}/u.test(
        ch
      )
    ) {
      width += 2;
    } else if (!/\p{M}/u.test(ch)) {
      width += 1;
    }
  }
  return width;
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function writePrivateFile(file, text, { ownDir = true } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (ownDir && process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {}
  }
  const temp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
  );
  try {
    fs.writeFileSync(temp, text, { mode: 0o600 });
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(temp, 0o600);
      } catch {}
    }
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

export function writePrivateJson(file, data) {
  writePrivateFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function readJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) return { version: 1, accounts: [] };
  let index;
  try {
    index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch (error) {
    throw new Error(
      `account index at ${INDEX_FILE} is unreadable (${error.message})`
    );
  }
  if (!Array.isArray(index?.accounts)) {
    throw new Error(`account index at ${INDEX_FILE} has no accounts list`);
  }
  return index;
}

export function saveIndex(index) {
  writePrivateJson(INDEX_FILE, index);
}

export function tokenGet(email) {
  const store = readJsonFile(FILE_STORE, {});
  return store[email] ?? null;
}

export function tokenSet(email, record) {
  const store = readJsonFile(FILE_STORE, {});
  store[email] = record;
  writePrivateJson(FILE_STORE, store);
}

export function tokenDelete(email) {
  const store = readJsonFile(FILE_STORE, {});
  delete store[email];
  writePrivateJson(FILE_STORE, store);
}

export function readCache() {
  const cache = readJsonFile(CACHE_FILE, {});
  return cache && typeof cache === 'object' && !Array.isArray(cache) ? cache : {};
}

export function writeCache(cache) {
  try {
    writePrivateJson(CACHE_FILE, cache);
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withCacheLock(fn) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let fd;
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      fd = fs.openSync(CACHE_LOCK_FILE, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(CACHE_LOCK_FILE).mtimeMs;
      } catch {}
      if (age > LOCK_STALE_MS) {
        fs.rmSync(CACHE_LOCK_FILE, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw Object.assign(
          new Error('the usage cache is locked by another process'),
          { code: 'ELOCKED' }
        );
      }
      await sleep(15 + Math.random() * 35);
      continue;
    }
    try {
      return fn();
    } finally {
      fs.closeSync(fd);
      fs.rmSync(CACHE_LOCK_FILE, { force: true });
    }
  }
}

export async function cacheUpdate(key, patch, { replace = false } = {}) {
  try {
    await withCacheLock(() => {
      const cache = readCache();
      const entry = replace ? {} : { ...(cache[key] ?? {}) };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined) delete entry[k];
        else entry[k] = v;
      }
      cache[key] = entry;
      writeCache(cache);
    });
  } catch (error) {
    warn(`could not update usage cache: ${error.message}`);
  }
}

export async function cacheDelete(key) {
  try {
    await withCacheLock(() => {
      const cache = readCache();
      if (!(key in cache)) return;
      delete cache[key];
      writeCache(cache);
    });
  } catch (error) {
    warn(`could not delete cache key: ${error.message}`);
  }
}
