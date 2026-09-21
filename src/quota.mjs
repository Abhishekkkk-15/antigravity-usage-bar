import { exec, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execPromise = promisify(exec);
import {
  cacheUpdate,
  compact,
  readCache,
  redact,
  withCacheLock,
} from './storage.mjs';

export const MIN_FETCH_SPACING_MS = 60 * 1000; // 1 minute spacing per account
export const ACCOUNT_STAGGER_MS = 300;
export const RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000;
export const RATE_LIMIT_COOLDOWN_MAX_MS = 60 * 60 * 1000;
export const LIMITED_MEMORY_MS = 60 * 60 * 1000;
const SPACING_TOLERANCE_MS = 5 * 1000;
const INFLIGHT_WAIT_MS = 20 * 1000;
const MACHINE_KEY = '$machine';

export const SEVERITY_THRESHOLDS = { warning: 65, critical: 85 };
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export function pct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return null;
  }
  return Math.max(0, Math.min(100, Number(value)));
}

export function severityFor(percent) {
  if (percent === null || percent === undefined) return 'unknown';
  if (percent >= SEVERITY_THRESHOLDS.critical) return 'critical';
  if (percent >= SEVERITY_THRESHOLDS.warning) return 'warning';
  return 'ok';
}

export function formatRelative(ms) {
  if (ms <= 0) return 'now';
  const minutes = Math.round(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(mins).padStart(2, '0')}m`;
  return `${mins}m`;
}

export function formatLocal(date) {
  const rounded = new Date(Math.round(date.getTime() / 60000) * 60000);
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(rounded);
}

export function tierLabel(record) {
  if (record.tier) return record.tier;
  const plan = String(record.planType || '').toLowerCase();
  if (plan === 'pro' || plan === 'gemini-pro' || plan === 'paid') {
    return 'Antigravity Pro';
  }
  if (plan === 'payg' || record.billingType === 'payg') {
    return 'Pay-as-you-go';
  }
  if (plan === 'workspace' || record.hd) {
    return `Workspace (${record.hd || 'Enterprise'})`;
  }
  if (plan === 'api-key') {
    return 'Google AI Studio Key';
  }
  return 'Free Tier';
}

/**
 * Parse the tab-delimited or visual output of `agy -p "/usage"`:
 *
 * Tab format:
 * Gemini Models\tWeekly Limit Remaining\t16%\t2026-09-23T04:49:24Z
 * Gemini Models\tFive Hour Limit Remaining\t81%\t2026-09-21T10:17:04Z
 * Claude and GPT models\tWeekly Limit Remaining\t33%\t2026-09-24T07:55:57Z
 * Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-09-21T11:03:33Z
 */
export function parseAgyUsageOutput(text) {
  if (!text || typeof text !== 'string') return null;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const rawWindows = [];

  for (const line of lines) {
    const tabParts = line.split('\t').map((p) => p.trim()).filter(Boolean);
    if (tabParts.length >= 3) {
      const [groupName, limitName, pctRaw, timeRaw] = tabParts;
      const numMatch = pctRaw.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
      if (numMatch) {
        rawWindows.push({
          groupName,
          limitName,
          remaining: parseFloat(numMatch[1]),
          resetsAt: timeRaw || null,
        });
        continue;
      }
    }
  }

  // Visual text fallback
  if (rawWindows.length === 0) {
    let currentGroup = 'Gemini Models';
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/GEMINI MODELS/i.test(l)) {
        currentGroup = 'Gemini Models';
      } else if (/CLAUDE AND GPT MODELS/i.test(l)) {
        currentGroup = 'Claude and GPT models';
      } else if (/Weekly Limit Remaining/i.test(l) || /Five Hour Limit Remaining/i.test(l)) {
        const limitName = l;
        let remaining = null;
        let resetsAt = null;
        for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
          const ahead = lines[j];
          const pctM = ahead.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
          if (pctM && remaining === null) {
            remaining = parseFloat(pctM[1]);
          }
          const refM = ahead.match(/Refreshes in\s+([0-9]+h\s*[0-9]+m|[0-9]+m|[0-9]+h)/i);
          if (refM) {
            resetsAt = refM[1];
          }
        }
        if (remaining !== null) {
          rawWindows.push({
            groupName: currentGroup,
            limitName,
            remaining,
            resetsAt,
          });
        }
      }
    }
  }

  if (rawWindows.length === 0) return null;

  const windows = [];
  for (const item of rawWindows) {
    const isGemini = /gemini/i.test(item.groupName);
    const isSession = /five hour|5h|session/i.test(item.limitName);

    const key = isGemini
      ? (isSession ? 'gemini_5h' : 'gemini_weekly')
      : (isSession ? 'claude_5h' : 'claude_weekly');

    const label = isGemini
      ? (isSession ? 'Gemini 5h' : 'Gemini Weekly')
      : (isSession ? 'Claude/GPT 5h' : 'Claude/GPT Wk');

    const group = isSession ? 'session' : 'weekly';
    const remaining = pct(item.remaining);
    const usedPercent = remaining != null ? Math.max(0, Math.min(100, +(100 - remaining).toFixed(2))) : null;

    windows.push({
      key,
      group,
      label,
      percent: usedPercent,
      remainingPercent: remaining,
      resetsAt: item.resetsAt,
      severity: severityFor(usedPercent),
    });
  }

  const order = ['gemini_5h', 'gemini_weekly', 'claude_5h', 'claude_weekly'];
  windows.sort((a, b) => {
    const ia = order.indexOf(a.key);
    const ib = order.indexOf(b.key);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  return windows;
}

export function defaultAccountWindows() {
  return [
    {
      key: 'gemini_5h',
      group: 'session',
      label: 'Gemini 5h',
      percent: 0,
      remainingPercent: 100,
      resetsAt: new Date(Date.now() + 5 * 3600 * 1000).toISOString(),
      severity: 'ok',
    },
    {
      key: 'gemini_weekly',
      group: 'weekly',
      label: 'Gemini Weekly',
      percent: 0,
      remainingPercent: 100,
      resetsAt: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
      severity: 'ok',
    },
    {
      key: 'claude_5h',
      group: 'session',
      label: 'Claude/GPT 5h',
      percent: 0,
      remainingPercent: 100,
      resetsAt: new Date(Date.now() + 5 * 3600 * 1000).toISOString(),
      severity: 'ok',
    },
    {
      key: 'claude_weekly',
      group: 'weekly',
      label: 'Claude/GPT Wk',
      percent: 0,
      remainingPercent: 100,
      resetsAt: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
      severity: 'ok',
    },
  ];
}

/**
 * Run `agy -p "/usage"` to query the live active session telemetry.
 */
export async function queryAgyUsage({ timeout = 15000 } = {}) {
  if (process.env.AGY_USAGE_DISABLE_SPAWN) return null;
  let lastErr = null;

  // First try direct exec
  try {
    const { stdout } = await execPromise('agy -p "/usage"', { timeout });
    const parsed = parseAgyUsageOutput(stdout);
    if (parsed && parsed.length > 0) {
      return { windows: parsed, raw: stdout };
    }
  } catch (err) {
    lastErr = err.stderr || err.message;
  }

  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    path.join(localAppData, 'agy', 'bin', 'agy.exe'),
    path.join(localAppData, 'Programs', 'agy', 'agy.exe'),
    path.join(os.homedir(), '.local', 'bin', 'agy'),
    '/usr/local/bin/agy',
    '/opt/homebrew/bin/agy',
  ];

  for (const bin of candidates) {
    if (fs.existsSync(bin)) {
      try {
        const { stdout } = await execPromise(`"${bin}" -p "/usage"`, { timeout });
        const parsed = parseAgyUsageOutput(stdout);
        if (parsed && parsed.length > 0) {
          return { windows: parsed, raw: stdout };
        }
      } catch (err) {
        lastErr = err.stderr || err.message;
      }
    }
  }

  return lastErr ? { error: lastErr } : null;
}

/**
 * Standardize Antigravity / Gemini usage windows.
 */
export function normalizeWindows(usage) {
  if (!usage || typeof usage !== 'object') return [];

  if (usage.windows && Array.isArray(usage.windows)) {
    return usage.windows.map((w) => ({
      key: w.key || w.name,
      group: w.group || (String(w.key || '').includes('5h') ? 'session' : 'weekly'),
      label: w.label || w.name,
      percent: pct(w.percent),
      remainingPercent: pct(
        w.remainingPercent ?? (w.percent != null ? 100 - w.percent : null)
      ),
      resetsAt: w.resetsAt ?? null,
      severity: w.severity || severityFor(pct(w.percent)),
      limit: w.limit,
      used: w.used,
    }));
  }

  // Fallback for legacy rate limit windows if any
  const windows = [];
  if (usage.rpm != null) {
    const limit = usage.rpm.limit || 15;
    const used = usage.rpm.used || 0;
    const percent = pct((used / limit) * 100);
    windows.push({
      key: 'rpm',
      group: 'minute',
      label: '1m RPM',
      percent,
      resetsAt: usage.rpm.resets_at || null,
      severity: severityFor(percent),
      used,
      limit,
    });
  }

  if (usage.rpd != null) {
    const limit = usage.rpd.limit || 1500;
    const used = usage.rpd.used || 0;
    const percent = pct((used / limit) * 100);
    windows.push({
      key: 'daily',
      group: 'daily',
      label: 'Daily Quota',
      percent,
      resetsAt: usage.rpd.resets_at || null,
      severity: severityFor(percent),
      used,
      limit,
    });
  }

  return windows;
}

export function headroom(usage) {
  const windows = normalizeWindows(usage);
  const session = Math.max(
    0,
    ...windows.filter((w) => w.group === 'session').map((w) => w.percent ?? 0)
  );
  const weekly = Math.max(
    0,
    ...windows.filter((w) => w.group === 'weekly').map((w) => w.percent ?? 0)
  );
  return { session, weekly, worst: Math.max(session, weekly) };
}

function lastAttemptAt(entry) {
  return Math.max(entry.attemptedAt ?? 0, entry.fetchedAt ?? 0);
}

function spacingFor(entry, now) {
  const recentlyLimited =
    entry.lastLimitedAt && now - entry.lastLimitedAt < LIMITED_MEMORY_MS;
  return recentlyLimited ? MIN_FETCH_SPACING_MS * 2 : MIN_FETCH_SPACING_MS;
}

function inCooldown(entry, now) {
  return (entry.limitedUntil ?? 0) > now;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isDeadLoginError(message) {
  return /invalid_grant|token expired|revoked|no refresh token/i.test(
    String(message ?? '')
  );
}

function claimFetchSlot(email, now = Date.now(), { renewedAt = 0 } = {}) {
  const cache = readCache();
  const entry = cache[email] ?? {};
  if (inCooldown(entry, now)) return { kind: 'cooldown', entry };
  const sinceLast = now - lastAttemptAt(entry);
  const renewed =
    isDeadLoginError(entry.lastError) && renewedAt > lastAttemptAt(entry);
  if (!renewed && sinceLast < spacingFor(entry, now) - SPACING_TOLERANCE_MS) {
    const inflight =
      !entry.usage &&
      !entry.lastError &&
      Boolean(entry.attemptedAt) &&
      sinceLast < INFLIGHT_WAIT_MS;
    return { kind: inflight ? 'inflight' : 'spacing', entry };
  }
  const sinceAny = now - (cache[MACHINE_KEY]?.attemptedAt ?? 0);
  if (sinceAny < ACCOUNT_STAGGER_MS) {
    return { kind: 'wait', ms: ACCOUNT_STAGGER_MS - sinceAny, entry };
  }
  cache[email] = { ...entry, attemptedAt: now };
  cache[MACHINE_KEY] = { attemptedAt: now };
  return { kind: 'go', entry, claimedAt: now };
}

function rateLimitedMessage(entry) {
  return `rate limited — next try in ${formatRelative(
    (entry.limitedUntil ?? 0) - Date.now()
  )}`;
}

/**
 * Fetch real Antigravity / Gemini usage and model quotas.
 */
export async function fetchAntigravityUsage(record, { active = false } = {}) {
  const email = record.email;
  let gate;
  for (;;) {
    try {
      gate = await withCacheLock(() =>
        claimFetchSlot(email, Date.now(), { renewedAt: record.updatedAt ?? 0 })
      );
    } catch (error) {
      if (error.code !== 'ELOCKED') throw error;
      gate = { kind: 'spacing', entry: readCache()[email] ?? {} };
    }
    if (gate.kind === 'wait') {
      await sleep(gate.ms);
      continue;
    }
    if (gate.kind === 'inflight') {
      await sleep(500);
      continue;
    }
    break;
  }

  const { entry, claimedAt } = gate;
  if (gate.kind === 'cooldown') {
    if (entry.usage) {
      return compact({
        record,
        usage: entry.usage,
        fetchedAt: entry.fetchedAt,
        fromCache: true,
        stale: rateLimitedMessage(entry),
      });
    }
    throw new Error(rateLimitedMessage(entry));
  }

  if (gate.kind === 'spacing') {
    if (entry.usage && !isDeadLoginError(entry.lastError)) {
      const age = entry.fetchedAt
        ? ` — showing values from ${formatRelative(
            Date.now() - entry.fetchedAt
          )} ago`
        : '';
      return compact({
        record,
        usage: entry.usage,
        fetchedAt: entry.fetchedAt,
        fromCache: true,
        stale: entry.lastError ? `${entry.lastError}${age}` : undefined,
      });
    }
    if (entry.usage) {
      return { record, usage: entry.usage, fetchedAt: entry.fetchedAt, fromCache: true };
    }
  }

  // 1. Try querying real telemetry from `agy -p "/usage"` if active
  let usageData = null;
  let queryError = null;
  if (active) {
    try {
      const agyRes = await queryAgyUsage();
      if (agyRes && agyRes.windows) {
        usageData = {
          source: 'agy-telemetry',
          tier: tierLabel(record),
          windows: agyRes.windows,
        };
      } else if (agyRes?.error) {
        if (/PERMISSION_DENIED|scopes|Eligibility|quota project|log in/i.test(agyRes.error)) {
          queryError = 'Antigravity session expired / not logged in (run `agy` to log in, then `agy-usage add`)';
        } else {
          queryError = agyRes.error;
        }
      }
    } catch (err) {
      queryError = err.message;
    }
  }

  // 2. If not active or agy query didn't yield telemetry, check existing cache
  if (!usageData && entry.usage?.windows) {
    usageData = entry.usage;
  }

  // 3. If still no telemetry, initialize fresh default windows (0% used / 100% remaining)
  if (!usageData) {
    usageData = {
      source: 'initialized',
      tier: tierLabel(record),
      windows: defaultAccountWindows(),
    };
  }

  const fetchedAt = Date.now();
  await cacheUpdate(
    email,
    {
      usage: usageData,
      fetchedAt,
      attemptedAt: claimedAt || fetchedAt,
      lastLimitedAt: entry?.lastLimitedAt,
      lastError: queryError || null,
    },
    { replace: true }
  );

  return { record, usage: usageData, fetchedAt, fromCache: false, stale: queryError || undefined };
}
