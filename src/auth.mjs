import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  compact,
  readJsonFile,
  readJsonText,
  redact,
  safeEqual,
  warn,
  writePrivateFile,
} from './storage.mjs';

// Antigravity & Google Cloud OAuth / Gemini parameters
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

// Standard Google Cloud Desktop / ADC OAuth Client ID
export const DEFAULT_CLIENT_ID =
  process.env.AGY_OAUTH_CLIENT_ID ||
  '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com';

export const DEFAULT_CLIENT_SECRET =
  process.env.AGY_OAUTH_CLIENT_SECRET ||
  'd-FL95Q19q7MQmFpd7hHD0Ty';

export const DEFAULT_SCOPES =
  'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/accounts.reauth';

export const CALLBACK_PORT = 54321;
export const CALLBACK_PATH = '/callback';
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export const GEMINI_HOME =
  process.env.GEMINI_HOME || path.join(os.homedir(), '.gemini');
export const GEMINI_ACCOUNTS_FILE = path.join(GEMINI_HOME, 'google_accounts.json');

function base64url(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function pkcePair() {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(
    crypto.createHash('sha256').update(codeVerifier).digest()
  );
  const state = base64url(crypto.randomBytes(32));
  return { codeVerifier, challenge, state };
}

export function buildAuthorizeUrl({
  clientId = DEFAULT_CLIENT_ID,
  redirectUri,
  challenge,
  state,
  scopes = DEFAULT_SCOPES,
  prompt = 'select_account',
}) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline');
  if (prompt) url.searchParams.set('prompt', prompt);
  return url.toString();
}

const BROWSER_URL_HOSTS = new Set([
  new URL(GOOGLE_AUTH_URL).host,
  'accounts.google.com',
]);

export function isSafeBrowserUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || !BROWSER_URL_HOSTS.has(parsed.host)) {
    return false;
  }
  return !/["\r\n\0]/.test(url);
}

export function openBrowser(url) {
  if (!isSafeBrowserUrl(url)) return false;
  try {
    const child =
      process.platform === 'win32'
        ? spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], {
            stdio: 'ignore',
            detached: true,
            windowsVerbatimArguments: true,
            windowsHide: true,
          })
        : spawn(
            process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open',
            [url],
            { stdio: 'ignore', detached: true }
          );
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c]
  );
}

const CALLBACK_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  Connection: 'close',
};

export function waitForCallback(port, expectedState, callbackPath = CALLBACK_PATH) {
  let close = () => {};
  let bind = async () => port;
  const promise = new Promise((resolve, reject) => {
    const finishPage = (title, detail) =>
      `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:system-ui,sans-serif;padding:48px;background:#f8f9fa;color:#202124"><h2>✦ ${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p></body>`;

    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setImmediate(() => {
        try {
          server.close();
        } catch {}
      });
      fn(value);
    };

    const server = http.createServer((req, res) => {
      if (
        !req.url ||
        req.url.length > 8192 ||
        (req.method !== 'GET' && req.method !== 'HEAD')
      ) {
        res.writeHead(400, CALLBACK_HEADERS);
        res.end(finishPage('Antigravity Usage Bar', 'Unsupported request.'));
        return;
      }
      const requestUrl = new URL(req.url, `http://localhost:${port}`);
      const returnedState = requestUrl.searchParams.get('state');
      if (
        requestUrl.pathname !== callbackPath ||
        !safeEqual(returnedState ?? '', expectedState)
      ) {
        res.writeHead(404, CALLBACK_HEADERS);
        res.end(
          finishPage(
            'Antigravity Usage Bar',
            'This is not the login callback this session is waiting for.'
          )
        );
        return;
      }
      const code = requestUrl.searchParams.get('code');
      const authError = requestUrl.searchParams.get('error');
      const failure = authError
        ? `authorization failed: ${authError}`
        : !code
          ? 'no authorization code in callback'
          : null;

      res.writeHead(failure ? 400 : 200, CALLBACK_HEADERS);
      res.end(
        failure
          ? finishPage('Login Failed', failure)
          : finishPage(
              'Login Successful',
              'You can close this window and return to your terminal.'
            )
      );
      if (failure) settle(reject, new Error(failure));
      else settle(resolve, code);
    });

    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.maxHeadersCount = 64;

    const timer = setTimeout(() => {
      settle(
        reject,
        new Error('timed out waiting for browser login callback (5 min)')
      );
    }, LOGIN_TIMEOUT_MS);
    timer.unref?.();

    server.on('error', (error) => settle(reject, error));
    bind = () =>
      new Promise((bound, failed) => {
        const onError = (error) => {
          server.removeListener('listening', onListening);
          failed(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          bound(server.address().port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
    close = () =>
      settle(
        reject,
        Object.assign(new Error('login cancelled'), { code: 'ELOGINCANCELLED' })
      );
  });
  promise.catch(() => {});
  return { promise, close, bind: () => bind() };
}

export async function beginLogin({
  clientId = DEFAULT_CLIENT_ID,
  scopes = DEFAULT_SCOPES,
  manual = false,
} = {}) {
  const { codeVerifier, challenge, state } = pkcePair();
  if (manual) {
    const redirectUri = 'urn:ietf:wg:oauth:2.0:oob';
    return {
      authorizeUrl: buildAuthorizeUrl({
        clientId,
        redirectUri,
        challenge,
        state,
        scopes,
      }),
      redirectUri,
      codeVerifier,
      state,
      port: null,
      waitForCode: null,
      cancel: () => {},
    };
  }

  let callback = waitForCallback(CALLBACK_PORT, state);
  let port;
  try {
    port = await callback.bind();
  } catch (error) {
    if (error?.code !== 'EADDRINUSE') throw error;
    callback.close();
    await callback.promise.catch(() => {});
    callback = waitForCallback(0, state);
    port = await callback.bind();
  }

  const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;
  return {
    authorizeUrl: buildAuthorizeUrl({
      clientId,
      redirectUri,
      challenge,
      state,
      scopes,
    }),
    redirectUri,
    codeVerifier,
    state,
    port,
    waitForCode: () => callback.promise,
    cancel: callback.close,
  };
}

export async function exchangeAuthorizationCode({
  code,
  codeVerifier,
  redirectUri,
  clientId = DEFAULT_CLIENT_ID,
  clientSecret = DEFAULT_CLIENT_SECRET,
}) {
  const params = new URLSearchParams({
    client_id: clientId,
    code: String(code).trim(),
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  if (clientSecret) {
    params.set('client_secret', clientSecret);
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  const text = await res.text();
  const body = readJsonText(text) ?? text;
  if (!res.ok) {
    throw new Error(
      `code exchange failed (${res.status}): ${redact(
        typeof body === 'object' ? JSON.stringify(body) : body
      )}`
    );
  }
  return body;
}

export async function refreshGoogleToken(
  refreshToken,
  clientId = DEFAULT_CLIENT_ID,
  clientSecret = DEFAULT_CLIENT_SECRET
) {
  const params = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (clientSecret) {
    params.set('client_secret', clientSecret);
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  const text = await res.text();
  const body = readJsonText(text) ?? text;
  if (!res.ok) {
    throw new Error(
      `token refresh failed (${res.status}): ${redact(
        typeof body === 'object' ? JSON.stringify(body) : body
      )}`
    );
  }
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    idToken: body.id_token,
    scopes: typeof body.scope === 'string' ? body.scope.split(' ') : undefined,
  };
}

export async function fetchUserInfo(accessToken) {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  const body = readJsonText(text) ?? text;
  if (!res.ok) {
    throw new Error(
      `userinfo lookup failed (${res.status}): ${redact(
        typeof body === 'object' ? JSON.stringify(body) : body
      )}`
    );
  }
  return {
    email: body.email,
    name: body.name,
    picture: body.picture,
    hd: body.hd, // Google Workspace hosted domain if any
  };
}

export function emailFromIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length >= 2) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
      return payload.email || null;
    } catch {}
  }
  return null;
}

export const STORE_TARGET = 'gemini:antigravity';

export function readAgyCredentialStore() {
  if (process.env.AGY_USAGE_DISABLE_SPAWN) return null;
  if (process.platform === 'win32') {
    try {
      const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinCredIORead {
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags; public int Type; public string TargetName; public string Comment;
        public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
        public int Persist; public int AttributeCount; public IntPtr Attributes;
        public string TargetAlias; public string UserName;
    }
    public static string Read(string target) {
        IntPtr ptr;
        if (CredRead(target, 1, 0, out ptr)) {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            byte[] bytes = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, bytes, 0, cred.CredentialBlobSize);
            return Encoding.UTF8.GetString(bytes);
        }
        return null;
    }
}
"@
[WinCredIORead]::Read('${STORE_TARGET}')
`;
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
      if (out) return JSON.parse(out);
    } catch {}
  } else if (process.platform === 'darwin') {
    try {
      const out = execFileSync('security', ['find-generic-password', '-s', STORE_TARGET, '-w'], {
        encoding: 'utf8',
      }).trim();
      if (out) return JSON.parse(out);
    } catch {}
  } else {
    try {
      const out = execFileSync('secret-tool', ['lookup', 'service', STORE_TARGET], {
        encoding: 'utf8',
      }).trim();
      if (out) return JSON.parse(out);
    } catch {}
  }
  return null;
}

export function writeAgyCredentialStore(record) {
  if (process.env.AGY_USAGE_DISABLE_SPAWN) return true;
  const payload = JSON.stringify({
    token: {
      access_token: record.accessToken,
      token_type: 'Bearer',
      refresh_token: record.refreshToken,
      expiry: new Date(record.expiresAt || Date.now() + 3600000).toISOString(),
    },
    auth_method: record.authMethod || 'consumer',
    id_token: record.idToken || '',
  });

  if (process.platform === 'win32') {
    try {
      const b64 = Buffer.from(payload, 'utf8').toString('base64');
      const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinCredIOWrite {
    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWrite([In] ref CREDENTIAL userCredential, int flags);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags; public int Type; public string TargetName; public string Comment;
        public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
        public int Persist; public int AttributeCount; public IntPtr Attributes;
        public string TargetAlias; public string UserName;
    }
    public static bool Write(string target, string userName, string base64) {
        byte[] bytes = Convert.FromBase64String(base64);
        IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, blob, bytes.Length);
        CREDENTIAL cred = new CREDENTIAL();
        cred.Type = 1; cred.TargetName = target; cred.UserName = userName;
        cred.CredentialBlobSize = bytes.Length; cred.CredentialBlob = blob; cred.Persist = 2;
        bool res = CredWrite(ref cred, 0);
        Marshal.FreeHGlobal(blob);
        return res;
    }
}
"@
[WinCredIOWrite]::Write('${STORE_TARGET}', 'antigravity', '${b64}')
`;
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        encoding: 'utf8',
        windowsHide: true,
      });
      return true;
    } catch (e) {
      warn(`could not write to Windows Credential Manager: ${e.message}`);
      return false;
    }
  } else if (process.platform === 'darwin') {
    try {
      execFileSync('security', ['add-generic-password', '-U', '-s', STORE_TARGET, '-a', 'antigravity', '-w', payload]);
      return true;
    } catch (e) {
      warn(`could not write to macOS Keychain: ${e.message}`);
      return false;
    }
  } else {
    try {
      const child = spawn('secret-tool', ['store', '--label=gemini:antigravity', 'service', STORE_TARGET, 'username', 'antigravity'], {
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      child.stdin.end(payload);
      return true;
    } catch {}
  }
  return false;
}

export function readAgyActiveConfig() {
  const accounts = readJsonFile(GEMINI_ACCOUNTS_FILE, null);
  return {
    activeEmail: accounts?.active ?? null,
    storedAccounts: Array.isArray(accounts?.old) ? accounts.old : [],
  };
}

export function writeAgyActiveConfig(email) {
  const current = readJsonFile(GEMINI_ACCOUNTS_FILE, { active: null, old: [] });
  const oldList = Array.isArray(current.old) ? current.old : [];
  if (current.active && current.active !== email && !oldList.includes(current.active)) {
    oldList.push(current.active);
  }
  const next = {
    active: email,
    old: oldList.filter((e) => e !== email),
  };
  writePrivateFile(GEMINI_ACCOUNTS_FILE, `${JSON.stringify(next, null, 2)}\n`, {
    ownDir: false,
  });
  return next;
}
