import {
  beginLogin,
  emailFromIdToken,
  exchangeAuthorizationCode,
  fetchUserInfo,
  isSafeBrowserUrl,
  openBrowser,
  readAgyActiveConfig,
  readAgyCredentialStore,
  refreshGoogleToken,
  writeAgyActiveConfig,
  writeAgyCredentialStore,
} from './auth.mjs';
import {
  fetchAntigravityUsage,
  formatLocal,
  formatRelative,
  headroom,
  isDeadLoginError,
  normalizeWindows,
  pct,
  severityFor,
  tierLabel,
} from './quota.mjs';
import {
  cacheDelete,
  compact,
  displayWidth,
  INDEX_FILE,
  loadIndex,
  maskEmail,
  redact,
  safeEqual,
  saveIndex,
  scrub,
  setLogger,
  tokenDelete,
  tokenGet,
  tokenSet,
  warn,
} from './storage.mjs';

export const VERSION = '1.0.0';
export const PROVIDER = 'antigravity';
export const PROVIDER_NAME = 'Antigravity';
export const PROVIDER_GLYPH = '✦';

export {
  INDEX_FILE,
  beginLogin,
  displayWidth,
  formatLocal,
  formatRelative,
  headroom,
  isDeadLoginError,
  isSafeBrowserUrl,
  loadIndex,
  maskEmail,
  normalizeWindows,
  openBrowser,
  pct,
  redact,
  safeEqual,
  saveIndex,
  scrub,
  setLogger,
  severityFor,
  tierLabel,
  tokenDelete,
  tokenGet,
  tokenSet,
};

export function isExpired(record, marginMs = 5 * 60 * 1000) {
  return !record.expiresAt || record.expiresAt - Date.now() <= marginMs;
}

export function loadRecords(index = loadIndex()) {
  return index.accounts.map((entry) => {
    const record = tokenGet(entry.email);
    return record
      ? { ...record, email: entry.email, label: entry.label }
      : { email: entry.email, label: entry.label, missing: true };
  });
}

export function findAccount(target) {
  const name = String(target ?? '').trim();
  const index = loadIndex();
  const pool = index.accounts;

  const byEmail = pool.filter(
    (a) => a.email.toLowerCase() === name.toLowerCase()
  );
  if (byEmail.length === 1) {
    return { index, entry: byEmail[0] };
  }

  const byLabel = pool.filter(
    (a) => a.label.toLowerCase() === name.toLowerCase()
  );
  if (byLabel.length > 1) {
    throw new Error(
      `label "${name}" matches ${byLabel.length} accounts (${byLabel
        .map((a) => a.email)
        .join(', ')}) — use the email address instead`
    );
  }
  if (byLabel.length === 1) {
    return { index, entry: byLabel[0] };
  }
  return null;
}

export async function ensureFresh(record, { force = false } = {}) {
  if (!force && !isExpired(record)) return record;
  if (!record.refreshToken) {
    if (record.apiKey) return record; // API key authentication never expires
    throw new Error(
      `no refresh token stored for ${record.email}; run \`agy-usage login\` for this account`
    );
  }
  const fresh = await refreshGoogleToken(record.refreshToken);
  const next = { ...record, ...fresh, updatedAt: Date.now() };
  tokenSet(record.email, next);
  return next;
}

export async function persistAccount(
  working,
  { label: requestedLabel, source = 'oauth-login' } = {}
) {
  const email = working.email;
  if (!email) throw new Error('cannot persist account without email');

  const index = loadIndex();
  const existing = index.accounts.find((a) => a.email === email);
  const label = requestedLabel || existing?.label || email.split('@')[0];

  const clash = index.accounts.find(
    (a) => a !== existing && a.label.toLowerCase() === label.toLowerCase()
  );
  if (clash) {
    warn(
      `label "${label}" is also used by ${clash.email} — use the email address to distinguish them`
    );
  }

  const previous = tokenGet(email);
  const record = compact({
    ...previous,
    ...working,
    email,
    label,
    source: source ?? previous?.source,
    capturedAt: previous?.capturedAt ?? Date.now(),
    updatedAt: Date.now(),
  });

  tokenSet(email, record);
  if (existing) {
    existing.label = label;
  } else {
    index.accounts.push({
      email,
      label,
      provider: PROVIDER,
      addedAt: new Date().toISOString(),
    });
  }
  saveIndex(index);
  return { record, label, email, isNew: !existing };
}

export async function completeLogin({
  code,
  state,
  codeVerifier,
  redirectUri,
  label,
  clientId,
  tier,
}) {
  const tokenRes = await exchangeAuthorizationCode({
    code,
    codeVerifier,
    redirectUri,
    clientId,
  });
  const userInfo = await fetchUserInfo(tokenRes.access_token);
  const detectedPlan = tier ? tier.toLowerCase() : userInfo.hd ? 'workspace' : 'pro';
  const working = {
    email: userInfo.email,
    name: userInfo.name,
    hd: userInfo.hd,
    accessToken: tokenRes.access_token,
    refreshToken: tokenRes.refresh_token,
    idToken: tokenRes.id_token,
    expiresAt: Date.now() + (Number(tokenRes.expires_in) || 3600) * 1000,
    scopes: typeof tokenRes.scope === 'string' ? tokenRes.scope.split(' ') : [],
    planType: detectedPlan,
  };
  return persistAccount(working, { label, source: 'oauth-login' });
}

export async function addApiKey(apiKey, { label: requestedLabel, tier = 'Google AI Studio Key' } = {}) {
  const cleanKey = String(apiKey).trim();
  if (!cleanKey) throw new Error('no API key provided');

  // Validate API key against Google Generative Language API
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cleanKey)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'antigravity-usage-bar/1.0' },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`invalid Google API key (${res.status}): ${redact(body)}`);
  }

  const data = await res.json();
  const models = Array.isArray(data.models) ? data.models : [];
  const keyFingerprint = cleanKey.slice(0, 8) + '...' + cleanKey.slice(-4);
  const email = `key-${keyFingerprint}`;
  const label = requestedLabel || `key-${cleanKey.slice(-4)}`;

  const working = {
    email,
    apiKey: cleanKey,
    planType: 'api-key',
    tier,
    source: 'api-key',
    modelsAvailable: models.length,
  };

  return persistAccount(working, { label, source: 'api-key' });
}

export async function setAccountTier(target, tierName) {
  const found = findAccount(target);
  if (!found) throw new Error(`no tracked account matches "${target}"`);
  const cleanTier = String(tierName || '').toLowerCase().trim();
  const normalizedTier = cleanTier.includes('pro')
    ? 'pro'
    : cleanTier.includes('work')
      ? 'workspace'
      : cleanTier.includes('pay')
        ? 'paid'
        : 'free';

  const record = tokenGet(found.entry.email) || { email: found.entry.email, label: found.entry.label };
  const updated = {
    ...record,
    planType: normalizedTier,
    tier: normalizedTier === 'pro' ? 'Gemini Pro (Advanced)' : normalizedTier === 'workspace' ? 'Workspace' : normalizedTier === 'paid' ? 'Pay-as-you-go' : 'Free Tier',
    updatedAt: Date.now(),
  };
  tokenSet(found.entry.email, updated);
  await cacheDelete(found.entry.email);
  return { entry: found.entry, tier: updated.tier };
}

export async function captureFromAgy({ label, email: requestedEmail, tier } = {}) {
  const creds = readAgyCredentialStore();
  const agyConfig = readAgyActiveConfig();
  const idEmail = emailFromIdToken(creds?.id_token);
  const email = requestedEmail || idEmail || agyConfig.activeEmail;
  if (!email) {
    throw new Error(
      'no active Antigravity CLI account found in environment.'
    );
  }
  const working = {
    email,
    accessToken: creds?.token?.access_token,
    refreshToken: creds?.token?.refresh_token,
    idToken: creds?.id_token,
    authMethod: creds?.auth_method || 'consumer',
    expiresAt: creds?.token?.expiry ? new Date(creds.token.expiry).getTime() : Date.now() + 3600000,
    planType: tier ? tier.toLowerCase() : 'pro',
    source: 'agy-cli',
  };
  return persistAccount(working, { label: label || email.split('@')[0], source: 'agy-cli' });
}

export async function switchAccount(target) {
  const found = findAccount(target);
  if (!found) throw new Error(`no tracked account matches "${target}"`);
  const { entry } = found;
  const activeConfig = readAgyActiveConfig();
  const alreadyActive = activeConfig.activeEmail === entry.email;

  const rawRecord = tokenGet(entry.email) || { email: entry.email, label: entry.label };
  let freshRecord = rawRecord;
  if (rawRecord.refreshToken) {
    try {
      freshRecord = await ensureFresh(rawRecord);
    } catch {}
  }

  // Update OS credential store (gemini:antigravity) so agy actually uses this account!
  if (freshRecord.accessToken) {
    await writeAgyCredentialStore(freshRecord);
  }

  writeAgyActiveConfig(entry.email);
  await cacheDelete(entry.email);

  try {
    await fetchAntigravityUsage(freshRecord, { active: true });
  } catch {}

  return {
    entry,
    alreadyActive,
    previousActive: activeConfig.activeEmail,
  };
}

export async function removeAccount(target) {
  const found = findAccount(target);
  if (!found) throw new Error(`no tracked account matches "${target}"`);
  tokenDelete(found.entry.email);
  found.index.accounts = found.index.accounts.filter(
    (a) => a.email !== found.entry.email
  );
  saveIndex(found.index);
  await cacheDelete(found.entry.email);
  return found.entry;
}

export function loginHealth(result) {
  const record = result.record ?? result;
  if (record.missing) {
    return { state: 'missing', message: 'no stored credentials — sign in again', action: 'login' };
  }
  if (record.apiKey) {
    return { state: 'ok', message: 'authenticated via API key' };
  }
  if (result.needsLogin) {
    return { state: 'expired', message: 'login expired — sign in again', action: 'login' };
  }
  if (record.expiresAt && record.expiresAt <= Date.now()) {
    return { state: 'expired', message: 'token expired — sign in again', action: 'login' };
  }
  if (record.expiresAt && record.expiresAt - Date.now() < 5 * 86400000) {
    return {
      state: 'expiring',
      message: `token expires in ${formatRelative(record.expiresAt - Date.now())}`,
      action: 'login',
    };
  }
  return { state: 'ok', message: 'login active' };
}

export function sortResults(results, mode) {
  if (!mode || mode === 'added') return results;
  return [...results].sort((a, b) => {
    const ha = a.error ? 999 : headroom(a.usage).worst;
    const hb = b.error ? 999 : headroom(b.usage).worst;
    return ha - hb;
  });
}

export async function collect({ sort } = {}) {
  const index = loadIndex();
  if (index.accounts.length === 0) {
    return { results: [], activeEmail: null, empty: true };
  }
  const records = loadRecords(index);
  const { activeEmail } = readAgyActiveConfig();

  const results = await Promise.all(
    records.map(async (record) => {
      const active = Boolean(activeEmail) && record.email === activeEmail;
      if (record.missing) {
        return {
          record,
          active,
          error: 'credentials not found in store — run `agy-usage login` for this account',
        };
      }
      try {
        const { record: fresh, usage, fetchedAt, stale } =
          await fetchAntigravityUsage(record, { active });
        return { record: fresh, active, usage, fetchedAt, stale };
      } catch (error) {
        return {
          record,
          active,
          error: error.message,
          needsLogin: isDeadLoginError(error.message),
        };
      }
    })
  );

  return {
    results: sortResults(results, sort),
    activeEmail,
    empty: false,
  };
}
