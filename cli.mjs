#!/usr/bin/env node
import readline from 'node:readline/promises';
import * as core from './src/core.mjs';

const BAR_WIDTH = 20;

const opts = parseArgs(process.argv.slice(2));
const useColor =
  !opts.flags['no-color'] && process.stdout.isTTY && !process.env.NO_COLOR;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const inlineValue = eq === -1 ? undefined : a.slice(eq + 1);
      if (inlineValue !== undefined) flags[key] = inlineValue;
      else if (['label', 'interval', 'sort', 'client-id'].includes(key)) flags[key] = argv[++i];
      else flags[key] = true;
    } else if (a === '-h') flags.help = true;
    else if (a === '-v' || a === '-V') flags.version = true;
    else positional.push(a);
  }
  return {
    command: positional[0] || 'status',
    args: positional.slice(1),
    flags,
  };
}

function paint(code, text) {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
}
const bold = (t) => paint('1', t);
const dim = (t) => paint('2', t);
const green = (t) => paint('32', t);
const yellow = (t) => paint('33', t);
const red = (t) => paint('31', t);
const cyan = (t) => paint('36', t);
const magenta = (t) => paint('35', t);

function fail(message) {
  console.error(red(`error: ${core.redact(message)}`));
  process.exit(1);
}

core.setLogger({
  onWarn: (message) => console.error(yellow(`warn: ${core.redact(message)}`)),
  onInfo: (message) => {
    if (!opts.flags.json) console.error(dim(message));
  },
});

function colorFor(p) {
  const severity = core.severityFor(p);
  if (severity === 'critical') return red;
  if (severity === 'warning') return yellow;
  if (severity === 'ok') return green;
  return dim;
}

function bar(p) {
  if (p === null) return dim('─'.repeat(BAR_WIDTH));
  const filled = Math.round((p / 100) * BAR_WIDTH);
  return colorFor(p)('█'.repeat(filled)) + dim('░'.repeat(BAR_WIDTH - filled));
}

const padVisible = (text, width) =>
  text +
  ' '.repeat(
    Math.max(0, width - core.displayWidth(text.replace(/\x1b\[[0-9;]*m/g, '')))
  );

function renderAccount(result, labelWidth) {
  const { record, usage, error, active } = result;
  const lines = [];
  const marker = active ? green('●') : dim('○');
  const tag = magenta(`${core.PROVIDER_GLYPH} ${core.PROVIDER_NAME}`);
  const title = `${marker} ${tag} ${bold(
    padVisible(record.label, labelWidth)
  )} ${dim(record.email)}`;
  const health = core.loginHealth(result);
  const loginNote =
    health.state === 'expired' || health.state === 'missing'
      ? red(`${health.message} → agy-usage login --label ${record.label}`)
      : health.state === 'expiring'
        ? yellow(health.message)
        : dim(health.message);

  const meta = [
    core.tierLabel(record),
    active ? green('active in agy') : '',
    loginNote,
  ]
    .filter(Boolean)
    .join(dim(' · '));

  lines.push(`${title}${meta ? `  ${meta}` : ''}`);
  if (error) {
    lines.push(`  ${red('✖')} ${error}`);
    return lines;
  }
  if (result.stale) lines.push(`  ${yellow('!')} ${dim(result.stale)}`);

  const now = Date.now();
  const windows = core.normalizeWindows(usage);
  const windowLabelWidth = Math.max(12, ...windows.map((w) => w.label.length));

  for (const window of windows) {
    const p = window.percent;
    const label = window.label.padEnd(windowLabelWidth);
    const pctText =
      p === null
        ? dim('  n/a')
        : colorFor(p)(`${String(Math.round(p)).padStart(3)}%`);
    const parts = [];
    if (window.remainingPercent != null) {
      parts.push(dim(`(${Math.round(window.remainingPercent)}% remaining)`));
    } else if (window.used != null && window.limit != null) {
      parts.push(dim(`(${window.used.toLocaleString()} / ${window.limit.toLocaleString()})`));
    }
    if (window.resetsAt) {
      const at = new Date(window.resetsAt);
      if (!Number.isNaN(at.getTime())) {
        parts.push(
          dim(`resets in ${core.formatRelative(at.getTime() - now)} (${core.formatLocal(at)})`)
        );
      } else {
        parts.push(dim(`refreshes in ${window.resetsAt}`));
      }
    }
    lines.push(`  ${label} ${bar(p)}  ${pctText}   ${parts.join('  ')}`);
  }
  return lines;
}

function summarize(results) {
  const ok = results.filter((r) => !r.error);
  if (ok.length === 0) return [];
  const best = [...ok].sort((a, b) => {
    const sa = core.headroom(a.usage);
    const sb = core.headroom(b.usage);
    return Math.max(sa.session, sa.weekly) - Math.max(sb.session, sb.weekly) || sa.session - sb.session;
  })[0];

  const hr = core.headroom(best.usage);
  const lines = [
    `${cyan('→')} most headroom now: ${bold(best.record.label)} ${dim(
      `(5h ${Math.round(hr.session)}% · 7d ${Math.round(hr.weekly)}% used)`
    )}`,
  ];
  return lines;
}

function render(results) {
  const labelWidth = Math.max(
    ...results.map((r) => core.displayWidth(r.record.label)),
    4
  );
  const out = [
    bold(`✦ Antigravity Multi-Account Usage`) +
      dim(`  ${core.formatLocal(new Date())}  (${Intl.DateTimeFormat().resolvedOptions().timeZone})`),
    '',
  ];
  for (const result of results) {
    out.push(...renderAccount(result, labelWidth), '');
  }
  out.push(...summarize(results));
  return out.join('\n');
}

function toJson(results) {
  return results.map((result) => {
    const { record, usage, error } = result;
    return {
      provider: core.PROVIDER,
      email: record.email,
      label: record.label,
      active: Boolean(result.active),
      tier: core.tierLabel(record) || null,
      login: core.loginHealth(result),
      windows: core.normalizeWindows(usage),
      usage: usage ?? null,
      stale: result.stale ?? null,
      fetchedAt: result.fetchedAt ? new Date(result.fetchedAt).toISOString() : null,
      error: error ?? null,
    };
  });
}

async function gather() {
  const { results, empty } = await core.collect({ sort: opts.flags.sort });
  if (opts.flags.json) return { results };
  if (empty) {
    fail('no accounts tracked yet. Run `agy-usage login` (or `agy-usage add`) to add one.');
  }
  return { results };
}

async function cmdStatus() {
  const { results } = await gather();
  if (opts.flags.json) {
    console.log(JSON.stringify(toJson(results), null, 2));
    return;
  }
  console.log(render(results));
}

function redraw(text) {
  process.stdout.write(
    `\x1b[H${text
      .split('\n')
      .map((line) => `${line}\x1b[K`)
      .join('\n')}\n\x1b[J`
  );
}

async function cmdWatch() {
  const interval = Math.max(10, Number(opts.flags.interval) || 30) * 1000;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    let body;
    try {
      const { results } = await gather();
      body = render(results);
    } catch (error) {
      body = red(`error: ${core.redact(error.message)}`);
    } finally {
      running = false;
    }
    redraw(
      `${body}\n\n${dim(
        `redrawing every ${interval / 1000}s · rate-limit protected · ctrl+c to quit`
      )}`
    );
  };
  process.stdout.write('\x1b[2J\x1b[H');
  await tick();
  const timer = setInterval(tick, interval);
  process.on('SIGINT', () => {
    clearInterval(timer);
    process.stdout.write('\n');
    process.exit(0);
  });
}

async function promptLine(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function cmdLogin() {
  const manual = Boolean(opts.flags.manual);
  const clientId = opts.flags['client-id'];
  const session = await core.beginLogin({ manual, clientId });

  let code;
  try {
    if (manual) {
      console.log(
        `open this URL in a browser to sign in to the Google/Antigravity account:\n\n  ${cyan(
          session.authorizeUrl
        )}\n`
      );
      if (!opts.flags['no-open']) core.openBrowser(session.authorizeUrl);
      code = await promptLine('paste the authorization code from Google: ');
      if (!code) fail('no code entered');
    } else {
      console.log(`opening browser for Google / Antigravity login…`);
      console.log(dim(`if no browser opens, use this URL:\n  ${session.authorizeUrl}`));
      if (!opts.flags['no-open']) core.openBrowser(session.authorizeUrl);
      code = await session.waitForCode();
    }
  } catch (error) {
    session.cancel();
    throw error;
  }

  const saved = await core.completeLogin({
    code,
    state: session.state,
    codeVerifier: session.codeVerifier,
    redirectUri: session.redirectUri,
    label: opts.flags.label,
    clientId,
  });

  console.log(
    `${green('✔')} ${saved.isNew ? 'added' : 'updated'} ${bold(saved.label)} ${dim(
      saved.email
    )}`
  );
}

async function cmdAdd() {
  const email = opts.args[0];
  const saved = await core.captureFromAgy({
    label: opts.flags.label,
    email,
  });
  console.log(
    `${green('✔')} tracked active Antigravity account ${bold(saved.label)} ${dim(
      saved.email
    )}`
  );
}

async function cmdAddKey() {
  const key = opts.args[0];
  if (!key) fail('usage: agy-usage add-key <API_KEY> [--label NAME]');
  console.log(dim('validating API key against Google Generative Language API…'));
  const saved = await core.addApiKey(key, { label: opts.flags.label });
  console.log(
    `${green('✔')} validated and added ${bold(saved.label)} ${dim(saved.email)} (${saved.record.modelsAvailable} models available)`
  );
}

async function cmdList() {
  const index = core.loadIndex();
  if (index.accounts.length === 0) {
    console.log(dim('no accounts tracked. Run `agy-usage login` or `agy-usage add` to add one.'));
    return;
  }
  const records = core.loadRecords(index);
  const labelWidth = Math.max(8, ...records.map((r) => core.displayWidth(r.label)));
  for (const record of records) {
    const state = record.missing
      ? red('credentials missing')
      : record.expiresAt
        ? `valid for ${core.formatRelative(record.expiresAt - Date.now())}`
        : 'active';
    console.log(
      `${magenta('✦')} ${bold(padVisible(record.label, labelWidth))} ${padVisible(
        record.email,
        28
      )} ${dim(state)}`
    );
  }
}

async function cmdRemove() {
  const target = opts.args[0];
  if (!target) fail('usage: agy-usage remove <email|label>');
  const entry = await core.removeAccount(target);
  console.log(`${green('✔')} removed account ${entry.email}`);
}

async function cmdSwitch() {
  const target = opts.args[0];
  if (!target) fail('usage: agy-usage switch <email|label>');
  const result = await core.switchAccount(target);
  if (result.alreadyActive) {
    console.log(`${green('✔')} agy already uses ${result.entry.email}`);
    return;
  }
  console.log(
    `${green('✔')} agy active account switched to ${bold(result.entry.label)} ${dim(
      result.entry.email
    )}`
  );
}

async function cmdTier() {
  const target = opts.args[0];
  const tier = opts.args[1];
  if (!target || !tier) fail('usage: agy-usage tier <email|label> <pro|free|workspace|payg>');
  const result = await (await import('./src/core.mjs')).setAccountTier(target, tier);
  console.log(
    `${green('✔')} updated ${bold(result.entry.label)} ${dim(result.entry.email)} tier to ${cyan(result.tier)}`
  );
}

async function cmdWhoami() {
  const { activeEmail } = (await import('./src/auth.mjs')).readAgyActiveConfig();
  if (!activeEmail) {
    console.log(dim('no active Antigravity CLI account found in ~/.gemini'));
    return;
  }
  console.log(`active in agy: ${bold(activeEmail)}`);
}

async function cmdInstall() {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execSync } = await import('node:child_process');

  const installDir = path.join(os.homedir(), '.antigravity-usage');
  const binDir = path.join(installDir, 'bin');
  const appDir = path.join(installDir, 'app');

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(appDir, { recursive: true });

  const rootDir = process.cwd();
  console.log(dim(`installing application files to ${appDir}...`));
  fs.copyFileSync(path.join(rootDir, 'cli.mjs'), path.join(appDir, 'cli.mjs'));
  fs.copyFileSync(path.join(rootDir, 'package.json'), path.join(appDir, 'package.json'));
  fs.cpSync(path.join(rootDir, 'src'), path.join(appDir, 'src'), { recursive: true, force: true });

  if (process.platform === 'win32') {
    const cmdContent = `@echo off\r\nnode "%~dp0..\\app\\cli.mjs" %*\r\n`;
    fs.writeFileSync(path.join(binDir, 'agy-usage.cmd'), cmdContent, 'utf8');
    fs.writeFileSync(path.join(binDir, 'antigravity-usage.cmd'), cmdContent, 'utf8');
    try {
      execSync(`powershell -Command "[Environment]::SetEnvironmentVariable('PATH', [Environment]::GetEnvironmentVariable('PATH', 'User') + ';${binDir}', 'User')"`, { stdio: 'ignore' });
    } catch {}
  } else {
    const shContent = `#!/usr/bin/env bash\nDIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/../app" >/dev/null 2>&1 && pwd)"\nexec node "$DIR/cli.mjs" "$@"\n`;
    const agyBin = path.join(binDir, 'agy-usage');
    fs.writeFileSync(agyBin, shContent, { mode: 0o755 });
    try {
      fs.symlinkSync(agyBin, path.join(binDir, 'antigravity-usage'));
    } catch {}
    if (fs.existsSync('/usr/local/bin')) {
      try {
        fs.symlinkSync(agyBin, '/usr/local/bin/agy-usage');
      } catch {}
    }
  }

  console.log(`${green('✔')} ${bold('agy-usage')} installed successfully to ${binDir}`);
  console.log(dim(`restart your terminal or run \`agy-usage status\` to test.`));
}

function cmdHelp() {
  console.log(`${bold('agy-usage')} — Multi-account usage & rate limits for Google Antigravity CLI (agy)

${bold('usage')}
  agy-usage [status] [--json] [--sort headroom]   show all accounts & quota limits (default)
  agy-usage watch [--interval 30]                 live dashboard, auto-refreshes in terminal
  agy-usage login [--label NAME] [--tier pro]     sign in to a Google / Antigravity account via OAuth
  agy-usage add-key <API_KEY> [--label NAME]      validate & add a Google AI Studio API key
  agy-usage add [EMAIL] [--label NAME]            track account from current agy environment
  agy-usage switch <email|label>                  switch active account for Antigravity CLI
  agy-usage tier <email|label> <pro|free|work>    set subscription tier for an account
  agy-usage list                                  list tracked accounts and token validity
  agy-usage remove <email|label>                  remove account from tracking
  agy-usage whoami                                print active account configured in agy
  agy-usage install                               install command globally to PATH
  agy-usage --version | -h                        display version / help`);
}

const commands = {
  status: cmdStatus,
  watch: cmdWatch,
  login: cmdLogin,
  add: cmdAdd,
  'add-key': cmdAddKey,
  key: cmdAddKey,
  tier: cmdTier,
  'set-tier': cmdTier,
  list: cmdList,
  ls: cmdList,
  remove: cmdRemove,
  rm: cmdRemove,
  switch: cmdSwitch,
  use: cmdSwitch,
  whoami: cmdWhoami,
  install: cmdInstall,
  help: cmdHelp,
};

if (opts.flags.version) {
  console.log(`agy-usage ${core.VERSION}`);
  process.exit(0);
}

const handler = commands[opts.command];
if (!handler || opts.flags.help) {
  if (!handler && !opts.flags.help) console.error(red(`unknown command: ${opts.command}\n`));
  cmdHelp();
  process.exit(handler ? 0 : 1);
}

Promise.resolve()
  .then(() => handler())
  .catch((error) => fail(error.message));
