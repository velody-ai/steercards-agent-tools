import { DEFAULT_MCP_URL, loadConfig, validateMcpUrl } from './config.js';
import { Runtime } from './runtime.js';
import { setup, type SetupOptions, type SetupReport, type SetupDependencies } from './setup.js';
import { inspectProjectAgentKey, prepareProjectCredentials, type ProjectCredentials } from './setup-credentials.js';
import { SetupProgress, type SetupProgressEvent, type SetupTimings } from './setup-progress.js';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export const INSTALL_CODE_PATTERN = /^sc_install_[A-Za-z0-9_-]{43}$/;
const tokenPattern = /^sc_agent_[A-Za-z0-9_-]{43}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Receipt = { installationId: string; keyId: string; profileIds: string[] };
export interface CodeSetupReport {
  ok: boolean;
  status: 'completed' | 'failed' | 'dry-run' | 'confirmation-required';
  setup: SetupReport | null;
  credentials: { status: 'not-saved' | 'saved' | 'kept' | 'dry-run'; envFile?: string };
  doctor: { connected: boolean | null; keySource?: 'env-file'; toolCount?: number };
  receipt?: Receipt;
  error?: string;
  confirmation?: { question: string; choices: { id: 'keep' | 'replace'; flag: string; label: string }[] };
  timings: SetupTimings;
  nextSteps: string[];
}
export interface CodeSetupOptions extends SetupOptions {
  code: string;
  confirmExistingKey?: boolean;
  keepAgentKey?: boolean;
  replaceAgentKey?: boolean;
  onProgress?: (event: SetupProgressEvent) => void;
}
/** Isolated HTTP, filesystem failure and diagnostic fixtures; never needed by normal callers. */
export interface CodeSetupDependencies {
  fetch?: typeof fetch;
  setup?: SetupDependencies;
  doctor?: (cwd: string, url: string, signal: AbortSignal) => Promise<{ connected: boolean; keySource: 'env-file'; toolCount?: number }>;
  connectionTimeoutMs?: number;
}

const errors: Record<string, string> = {
  AGENT_INSTALL_CODE_NOT_FOUND: 'Installation code was not found. Create a new code in Steercards.',
  AGENT_INSTALL_CODE_EXPIRED: 'Installation code expired. Create a new code in Steercards.',
  AGENT_INSTALL_CODE_REVOKED: 'Installation code was revoked. Create a new code in Steercards.',
  AGENT_INSTALL_CODE_CONSUMED: 'Installation code was already used. Check the project .env and the selected Agent Key in Steercards. Do not redeem this code again.',
  AGENT_INSTALL_CODE_PROFILE_INVALID: 'The selected profiles are no longer available. Create a new installation code.',
  AGENT_INSTALL_CODE_OWNER_INVALID: 'The installation owner is no longer available. Sign in to Steercards and create a new code.',
  AGENT_INSTALL_KEY_NOT_FOUND: 'The selected Agent Key is no longer available. Check the code and key selection in Steercards before creating a new code.',
  AGENT_INSTALL_KEY_REVOKED: 'The selected Agent Key was revoked. Check its status in Steercards and select a usable key for a new code.',
  AGENT_INSTALL_KEY_EXPIRED: 'The selected Agent Key expired. Check its status in Steercards and select a usable key for a new code.',
  AGENT_INSTALL_KEY_ACCESS_CHANGED: 'The selected Agent Key access changed. Review its workspace and profiles in Steercards before creating a new code.',
  AGENT_INSTALL_KEY_TOKEN_MISMATCH: 'The selected Agent Key could not be verified. Preserve existing keys and check the code and selected key in Steercards before creating a new code.',
  AGENT_INSTALL_KEY_CAPSULE_INVALID: 'The installation code could not restore the selected Agent Key. Preserve existing keys and create a fresh code for the same usable key in Steercards.',
  RATE_LIMITED: 'Too many installation attempts. Wait before creating another request.',
};
const recovery = 'The code may have been consumed. Do not replay it. First check whether the project .env contains the Agent Key; preserve any saved key and rerun setup without a code, then doctor --connect. Otherwise, check the code status and selected key in Steercards. Preserve reused keys and create a new code for the same usable key. Only revoke a newly issued key if you explicitly confirm it is unused. Never paste the Agent Key into chat.';

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) { await response.body?.cancel(); throw new Error('Installation service returned an invalid response.'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Installation service returned an empty response.');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) { await reader.cancel(); throw new Error('Installation service response is too large.'); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Installation service returned invalid JSON.'); }
  } finally { reader.releaseLock(); }
}

async function exchange(code: string, url: string, fetcher: typeof fetch): Promise<{ token: string; receipt: Receipt }> {
  let response: Response;
  try {
    response = await fetcher(new URL('/api/agent-setup/exchange', url), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code }), redirect: 'error', signal: AbortSignal.timeout(15000),
    });
  } catch { throw new Error(`Unable to confirm installation code exchange. ${recovery}`); }
  let value: any;
  try { value = await boundedJson(response); }
  catch { throw new Error(`Installation service returned an invalid or incomplete response. ${recovery}`); }
  if (!response.ok) {
    const errorCode = value?.error?.code;
    const message = typeof errorCode === 'string' && Object.hasOwn(errors, errorCode) ? errors[errorCode] : undefined;
    throw new Error(message ?? `Installation service rejected the request (HTTP ${response.status}). ${recovery}`);
  }
  if (!value || typeof value.token !== 'string' || !tokenPattern.test(value.token)
    || typeof value.installationId !== 'string' || !uuidPattern.test(value.installationId)
    || !value.key || typeof value.key.id !== 'string' || !uuidPattern.test(value.key.id) || !Array.isArray(value.profileIds)
    || value.profileIds.length > 30 || value.profileIds.some((id: unknown) => typeof id !== 'string' || !uuidPattern.test(id))
    || new Set(value.profileIds).size !== value.profileIds.length) throw new Error(`Installation service returned invalid credentials. ${recovery}`);
  return { token: value.token, receipt: { installationId: value.installationId, keyId: value.key.id, profileIds: value.profileIds } };
}

async function doctor(cwd: string, url: string, signal: AbortSignal) {
  // Explicitly inspect the stored file, regardless of the invoking agent's environment.
  const config = await loadConfig({ cwd, envFile: '.env', url, env: {} });
  const runtime = new Runtime(config, { signal });
  try {
    const tools = await runtime.listTools();
    const result = await runtime.callTool('list_workspaces', {});
    let failed = result.isError === true || (result.structuredContent as { ok?: boolean } | undefined)?.ok === false;
    for (const item of result.content) if (item.type === 'text') {
      try { if (JSON.parse(item.text)?.ok === false) failed = true; } catch { /* Ordinary text is allowed. */ }
    }
    return { connected: !failed, keySource: 'env-file' as const, toolCount: tools.length };
  } finally { void runtime.close().catch(() => {}); }
}

async function checkConnection(cwd: string, url: string, dependencies: CodeSetupDependencies) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (dependencies.doctor ?? doctor)(cwd, url, controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Connection check timed out.')); }, dependencies.connectionTimeoutMs ?? 15000);
      }),
    ]);
  } finally { clearTimeout(timer); controller.abort(); }
}

class ConfirmationRequired extends Error {}
function requireConfirmation(report: CodeSetupReport): void {
  report.status = 'confirmation-required';
  report.confirmation = {
    question: '.env에 Key가 있어요. 기존 키를 사용하시겠습니까?',
    choices: [
      { id: 'keep', flag: '--keep-agent-key', label: '기존 키 사용' },
      { id: 'replace', flag: '--replace-agent-key', label: '설치 코드의 Key 사용' },
    ],
  };
  report.nextSteps = ['Ask the confirmation question and wait for the user. Rerun the same setup command and code with either --keep-agent-key or --replace-agent-key after their choice. No code was exchanged and no credentials, MCP configuration or skill were written.'];
}

/** Redeem only after local setup is ready; keep saved credentials if later configuration fails. */
export async function setupWithCode(options: CodeSetupOptions, dependencies: CodeSetupDependencies = {}): Promise<CodeSetupReport> {
  const progress = new SetupProgress(options.onProgress);
  const report: CodeSetupReport = { ok: false, status: 'failed', setup: null, credentials: { status: 'not-saved' }, doctor: { connected: null }, nextSteps: [], timings: progress.timings };
  let credentials: ProjectCredentials | undefined;
  let token: string | undefined;
  let attemptedExchange = false;
  let mcpUrl: string;
  progress.start('preflight');
  try {
    if (options.keepAgentKey && options.replaceAgentKey) throw new Error('Choose only one of --keep-agent-key or --replace-agent-key.');
    if (!INSTALL_CODE_PATTERN.test(options.code)) throw new Error('Installation code has an invalid format. Copy a fresh setup prompt from Steercards.');
    try { if (!(await stat(await realpath(resolve(options.cwd ?? process.cwd())))).isDirectory()) throw new Error(); }
    catch { throw new Error('The selected project directory must already exist.'); }
    mcpUrl = validateMcpUrl(options.url ?? DEFAULT_MCP_URL);
    if (options.confirmExistingKey && !options.keepAgentKey && !options.replaceAgentKey) {
      const inspected = await inspectProjectAgentKey({ cwd: options.cwd, envFile: options.envFile });
      if (inspected.hasAgentKey) {
        report.credentials.envFile = inspected.envFile;
        requireConfirmation(report);
        progress.finish();
        return report;
      }
    }
    report.setup = await setup({ ...options, url: mcpUrl }, {
      ...dependencies.setup,
      async afterPreflight(context) {
        credentials = await prepareProjectCredentials({ cwd: context.cwd, envFile: options.envFile, savedEnvFile: context.envFile, replaceAgentKey: options.replaceAgentKey, keepAgentKey: options.keepAgentKey, rejectEmptyAgentKey: options.confirmExistingKey, dryRun: context.dryRun });
        report.credentials.envFile = credentials.envFile;
        // Recheck under both locks if a key appeared after read-only discovery.
        if (options.confirmExistingKey && !options.keepAgentKey && !options.replaceAgentKey && !credentials.needsExchange) {
          requireConfirmation(report);
          throw new ConfirmationRequired();
        }
        const savedUrl = await credentials.readMcpUrl();
        if (savedUrl && new URL(validateMcpUrl(savedUrl)).origin !== new URL(mcpUrl).origin && options.url === undefined) throw new Error('The project uses another MCP server. Explicitly select its --url before redeeming an installation code.');
        progress.finish();
        if (context.dryRun) { report.credentials.status = 'dry-run'; progress.skip('credentials'); progress.skip('install'); return; }
        progress.start('credentials');
        await credentials.protect();
        if (!credentials.needsExchange) { token = await credentials.readKey(); report.credentials.status = 'kept'; progress.finish('skipped'); progress.start('install'); return; }
        await credentials.verify();
        attemptedExchange = true;
        const claimed = await exchange(options.code, mcpUrl, dependencies.fetch ?? fetch);
        token = claimed.token;
        report.receipt = claimed.receipt;
        try { await credentials.save(token); }
        catch { throw new Error(`The Agent Key could not be saved safely. ${recovery}`); }
        report.credentials.status = 'saved';
        progress.finish();
        progress.start('install');
      },
    });
    report.setup.actions.unshift(...credentials!.actions);
    report.setup.nextSteps = report.setup.nextSteps.filter(step => !step.startsWith('Set STEERCARDS_AGENT_KEY'));
    if (options.dryRun) { report.ok = true; report.status = 'dry-run'; progress.skip('connection'); report.nextSteps = ['Run setup again without --dry-run to complete installation.']; return report; }
    progress.finish();
    progress.start('connection');
    try { report.doctor = await checkConnection(credentials!.cwd, mcpUrl, dependencies); }
    catch { report.doctor = { connected: false, keySource: 'env-file' }; }
    report.ok = report.doctor.connected === true;
    progress.finish(report.ok ? 'completed' : 'failed');
    report.status = report.ok ? 'completed' : 'failed';
    report.nextSteps = [...report.setup.nextSteps, ...(!report.ok ? ['Credentials and setup were preserved. Run doctor --connect after checking the MCP server. Do not redeem the code again.'] : [])];
    if (!report.ok) report.error = 'Setup completed, but the connection check did not succeed.';
  } catch (error) {
    if (error instanceof ConfirmationRequired) { progress.finish(); return report; }
    report.status = 'failed';
    delete report.confirmation;
    progress.finish('failed');
    let message = error instanceof Error ? error.message : 'Installation failed.';
    for (const secret of [options.code, token, process.env.STEERCARDS_AGENT_KEY]) if (secret) message = message.split(secret).join('[REDACTED]');
    report.error = message;
    report.nextSteps = report.credentials.status === 'saved' || report.credentials.status === 'kept'
      ? ['The project .env was preserved. Fix the configuration conflict and rerun setup without an installation code, then doctor --connect.']
      : [attemptedExchange ? recovery : 'Resolve the local setup issue and rerun the prompt before the code expires.'];
  } finally {
    try { await credentials?.close(); }
    catch { report.ok = false; report.status = 'failed'; delete report.confirmation; report.error = 'Setup could not release its local lock. Review the project setup lock before retrying.'; }
    progress.complete();
  }
  return report;
}
