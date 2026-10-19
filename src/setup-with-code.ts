import { DEFAULT_MCP_URL, loadConfig, validateMcpUrl } from './config.js';
import { Runtime } from './runtime.js';
import { setup, type SetupOptions, type SetupReport, type SetupDependencies } from './setup.js';
import { prepareProjectCredentials, type ProjectCredentials } from './setup-credentials.js';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export const INSTALL_CODE_PATTERN = /^sc_install_[A-Za-z0-9_-]{43}$/;
const tokenPattern = /^sc_agent_[A-Za-z0-9_-]{43}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Receipt = { installationId: string; keyId: string; profileIds: string[] };
export interface CodeSetupReport {
  ok: boolean;
  setup: SetupReport | null;
  credentials: { status: 'not-saved' | 'saved' | 'kept' | 'dry-run'; envFile?: string };
  doctor: { connected: boolean | null; keySource?: 'env-file'; toolCount?: number };
  receipt?: Receipt;
  error?: string;
  nextSteps: string[];
}
export interface CodeSetupOptions extends SetupOptions { code: string; replaceAgentKey?: boolean }
/** Isolated HTTP, filesystem failure and diagnostic fixtures; never needed by normal callers. */
export interface CodeSetupDependencies {
  fetch?: typeof fetch;
  setup?: SetupDependencies;
  doctor?: (cwd: string, url: string) => Promise<{ connected: boolean; keySource: 'env-file'; toolCount?: number }>;
}

const errors: Record<string, string> = {
  AGENT_INSTALL_CODE_NOT_FOUND: 'Installation code was not found. Create a new code in Steercards.',
  AGENT_INSTALL_CODE_EXPIRED: 'Installation code expired. Create a new code in Steercards.',
  AGENT_INSTALL_CODE_REVOKED: 'Installation code was revoked. Create a new code in Steercards.',
  AGENT_INSTALL_CODE_CONSUMED: 'Installation code was already used. Check the issued Agent Key in Steercards before creating a new code.',
  AGENT_INSTALL_CODE_PROFILE_INVALID: 'The selected profiles are no longer available. Create a new installation code.',
  AGENT_INSTALL_CODE_OWNER_INVALID: 'The installation owner is no longer available. Sign in to Steercards and create a new code.',
  RATE_LIMITED: 'Too many installation attempts. Wait before creating another request.',
};
const recovery = 'The code may have been consumed. Create a new code and remove any unused issued Agent Key in Steercards. Never paste the Agent Key into chat.';

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

async function doctor(cwd: string, url: string) {
  // Explicitly inspect the stored file, regardless of the invoking agent's environment.
  const config = await loadConfig({ cwd, envFile: '.env', url, env: {} });
  const runtime = new Runtime(config);
  const timeout = setTimeout(() => { void runtime.close().catch(() => {}); }, 15000);
  timeout.unref();
  try {
    const tools = await runtime.listTools();
    const result = await runtime.callTool('list_workspaces', {});
    let failed = result.isError === true || (result.structuredContent as { ok?: boolean } | undefined)?.ok === false;
    for (const item of result.content) if (item.type === 'text') {
      try { if (JSON.parse(item.text)?.ok === false) failed = true; } catch { /* Ordinary text is allowed. */ }
    }
    return { connected: !failed, keySource: 'env-file' as const, toolCount: tools.length };
  } finally { clearTimeout(timeout); await runtime.close(); }
}

/** Redeem only after local setup is ready; keep saved credentials if later configuration fails. */
export async function setupWithCode(options: CodeSetupOptions, dependencies: CodeSetupDependencies = {}): Promise<CodeSetupReport> {
  const report: CodeSetupReport = { ok: false, setup: null, credentials: { status: 'not-saved' }, doctor: { connected: null }, nextSteps: [] };
  let credentials: ProjectCredentials | undefined;
  let token: string | undefined;
  let attemptedExchange = false;
  let mcpUrl: string;
  try {
    if (!INSTALL_CODE_PATTERN.test(options.code)) throw new Error('Installation code has an invalid format. Copy a fresh setup prompt from Steercards.');
    try { if (!(await stat(await realpath(resolve(options.cwd ?? process.cwd())))).isDirectory()) throw new Error(); }
    catch { throw new Error('The selected project directory must already exist.'); }
    mcpUrl = validateMcpUrl(options.url ?? DEFAULT_MCP_URL);
    report.setup = await setup({ ...options, url: mcpUrl }, {
      ...dependencies.setup,
      async afterPreflight(context) {
        credentials = await prepareProjectCredentials({ cwd: context.cwd, envFile: options.envFile, savedEnvFile: context.envFile, replaceAgentKey: options.replaceAgentKey, dryRun: context.dryRun });
        report.credentials.envFile = credentials.envFile;
        const savedUrl = await credentials.readMcpUrl();
        if (savedUrl && new URL(validateMcpUrl(savedUrl)).origin !== new URL(mcpUrl).origin && options.url === undefined) throw new Error('The project uses another MCP server. Explicitly select its --url before redeeming an installation code.');
        if (context.dryRun) { report.credentials.status = 'dry-run'; return; }
        await credentials.protect();
        if (!credentials.needsExchange) { report.credentials.status = 'kept'; return; }
        await credentials.verify();
        attemptedExchange = true;
        const claimed = await exchange(options.code, mcpUrl, dependencies.fetch ?? fetch);
        token = claimed.token;
        report.receipt = claimed.receipt;
        try { await credentials.save(token); }
        catch { throw new Error(`The issued Agent Key could not be saved safely. ${recovery}`); }
        report.credentials.status = 'saved';
      },
    });
    report.setup.actions.unshift(...credentials!.actions);
    report.setup.nextSteps = report.setup.nextSteps.filter(step => !step.startsWith('Set STEERCARDS_AGENT_KEY'));
    if (options.dryRun) { report.ok = true; report.nextSteps = ['Run setup again without --dry-run to complete installation.']; return report; }
    try { report.doctor = await (dependencies.doctor ?? doctor)(credentials!.cwd, mcpUrl); }
    catch { report.doctor = { connected: false, keySource: 'env-file' }; }
    report.ok = report.doctor.connected === true;
    report.nextSteps = [...report.setup.nextSteps, ...(!report.ok ? ['Credentials and setup were preserved. Run doctor --connect after checking the MCP server. Do not redeem the code again.'] : [])];
    if (!report.ok) report.error = 'Setup completed, but the connection check did not succeed.';
  } catch (error) {
    let message = error instanceof Error ? error.message : 'Installation failed.';
    for (const secret of [options.code, token]) if (secret) message = message.split(secret).join('[REDACTED]');
    report.error = message;
    report.nextSteps = report.credentials.status === 'saved' || report.credentials.status === 'kept'
      ? ['The project .env was preserved. Fix the configuration conflict and rerun setup without an installation code, then doctor --connect.']
      : [attemptedExchange ? recovery : 'Resolve the local setup issue and rerun the prompt before the code expires.'];
  } finally {
    try { await credentials?.close(); }
    catch { report.ok = false; report.error = 'Setup could not release its local lock. Review the project setup lock before retrying.'; }
  }
  return report;
}
