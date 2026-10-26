#!/usr/bin/env -S node --
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from './config.js';
import { Runtime } from './runtime.js';
import { startServer } from './server.js';
import { clientConfig, installSkill, exportSkill, packageInfo } from './install.js';
import { refreshManagedSetup, setup } from './setup.js';
import { setupWithCode } from './setup-with-code.js';

const help = `Steercards agent tools ${packageInfo.version}

steercards setup [--client CLIENT] [--local | --npx] [--dry-run]
  [--setup-code-stdin] [--confirm-existing-key] [--keep-agent-key | --replace-agent-key]
steercards serve [--mode compact|full] [--client CLIENT]
steercards tools [query] [--limit 10]
steercards describe NAME
steercards call NAME [--json JSON | --file PATH | --stdin]
steercards explore --workspace ID COMMAND [--board ID] [--status VALUE ...]
  [--archived active|archived|all] [--include-relations] [--cursor TOKEN] [--max-chars N]
steercards doctor [--connect]
steercards config CLIENT [--local] [--mode compact|full]
steercards skill install --client CLIENT [--global]
steercards skill export --output PATH.zip

Connection options: --cwd PATH --env-file PATH --url URL
Default .env: exactly --cwd/.env (otherwise current directory).
Environment: STEERCARDS_AGENT_KEY, optional STEERCARDS_MCP_URL.
Clients: claude-code, codex, codex-app, codex-cli, cursor, claude-desktop.
setup installs MCP configuration and the skill together.
setup uses project scope (Desktop uses its user configuration and a project ZIP).
Npm MCP commands use @latest at the next process start and sync managed skills.
--npx explicitly switches an existing local setup to npm automatic updates.
--dry-run previews setup without writing files. No key is needed for setup.
--setup-code-stdin reads a one-use installation code, protects the project .env,
  installs MCP and the skill, then checks the connection. Existing keys are kept.
--replace-agent-key explicitly replaces the project .env Agent Key.
--confirm-existing-key returns confirmation-required before writing when a key exists.
--keep-agent-key requires the existing project key and never exchanges a code.
Code setup emits safe progress JSONL to stderr and one final JSON report to stdout.
confirmation-required exits 0 with ok:false; wait for the user's key choice.
config only prints a snippet and never edits host settings.
--local uses this installation's absolute Node/CLI paths (works before npm release).
Claude Desktop: skill ZIP updates still require manual upload.
Full tool responses are JSON; tool/product errors exit nonzero. Writes are never retried.
explore forwards one quoted read-only virtual command to explore_cards, not a shell.
Use search_cards for simple title/body finding; explore for expressions and line evidence.
Start at a known board/path; ls only when its location is unknown. Stop when snippets suffice.
--status accepts an option ID or exact name; repeat it for up to 20 alternatives.
--archived defaults to all upstream; --include-relations adds parent/child summaries.
Full JSON preserves complete, nextCursor, stopReason, exitCode, sources and grouped matches.
Continue only as needed, with the same command/all options and exact --cursor.
Disclose incomplete coverage when stopping before complete is true.
`;

function output(value: unknown) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }
function isFailure(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as Record<string, unknown>;
  if (r.isError === true || (r.structuredContent as { ok?: boolean } | undefined)?.ok === false) return true;
  if (Array.isArray(r.content)) for (const item of r.content) {
    if (item.type === 'text') { try { if (JSON.parse(item.text)?.ok === false) return true; } catch {} }
  }
  return false;
}
async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 7 * 1024 * 1024) throw new Error('JSON input exceeds 7 MiB.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function installationCode(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024) throw new Error('Installation code input is too large.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

let secret = process.env.STEERCARDS_AGENT_KEY;
async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Steercards agent tools require Node.js 22 or newer. Install a supported Node.js version, then rerun setup.');
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    cwd: { type: 'string' }, 'env-file': { type: 'string' }, url: { type: 'string' }, mode: { type: 'string' },
    json: { type: 'string' }, file: { type: 'string' }, stdin: { type: 'boolean' },
    client: { type: 'string' }, global: { type: 'boolean' }, output: { type: 'string' },
    limit: { type: 'string' }, connect: { type: 'boolean' }, local: { type: 'boolean' },
    workspace: { type: 'string' }, cursor: { type: 'string' }, 'max-chars': { type: 'string' },
    board: { type: 'string' }, status: { type: 'string', multiple: true },
    archived: { type: 'string' }, 'include-relations': { type: 'boolean' },
    'dry-run': { type: 'boolean' }, npx: { type: 'boolean' },
    'setup-code-stdin': { type: 'boolean' }, 'replace-agent-key': { type: 'boolean' },
    'keep-agent-key': { type: 'boolean' }, 'confirm-existing-key': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  if (values.version) { process.stdout.write(packageInfo.version + '\n'); return; }
  if (values.help || positionals.length === 0) { process.stdout.write(help); return; }
  const [command, name, ...extra] = positionals;
  const options = { cwd: values.cwd, envFile: values['env-file'], url: values.url };
  if (extra.length) throw new Error('Unexpected extra arguments. Use --help.');
  if (command !== 'explore' && [values.workspace, values.cursor, values['max-chars'], values.board, values.status, values.archived, values['include-relations']].some(value => value !== undefined)) {
    throw new Error('--workspace, --cursor, --max-chars, --board, --status, --archived and --include-relations are only supported by explore.');
  }
  if (command === 'setup') {
    if (name) throw new Error('Use setup --client CLIENT.');
    for (const option of ['json', 'file', 'stdin', 'limit', 'output', 'connect'] as const) {
      if (values[option] !== undefined) throw new Error(`--${option} is not supported by setup.`);
    }
    if (values.global) throw new Error('setup uses project scope; omit --global. Claude Desktop configuration is user-scoped.');
    for (const option of ['replace-agent-key', 'keep-agent-key', 'confirm-existing-key'] as const) {
      if (values[option] && !values['setup-code-stdin']) throw new Error(`--${option} requires --setup-code-stdin.`);
    }
    if (values['keep-agent-key'] && values['replace-agent-key']) throw new Error('Choose only one of --keep-agent-key or --replace-agent-key.');
    if (values.local && values.npx) throw new Error('Choose only one of --local or --npx.');
    let client = values.client;
    if (!client) {
      if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('Noninteractive setup requires --client: codex, claude-code, cursor, or claude-desktop.');
      const choices = ['codex', 'claude-code', 'cursor', 'claude-desktop'];
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        process.stderr.write('Choose a client:\n1. Codex app / CLI\n2. Claude Code\n3. Cursor\n4. Claude Desktop\n');
        const answer = (await prompt.question('Client [1-4 or name]: ')).trim();
        client = /^[1-4]$/.test(answer) ? choices[Number(answer) - 1] : answer;
      } finally { prompt.close(); }
      if (!client) throw new Error('No client selected. Nothing was installed.');
    }
    const setupOptions = { ...options, client, local: values.npx ? false : values.local, mode: values.mode, dryRun: values['dry-run'] };
    if (values['setup-code-stdin']) {
      const code = await installationCode();
      secret = code;
      const result = await setupWithCode({ ...setupOptions, code,
        replaceAgentKey: values['replace-agent-key'], keepAgentKey: values['keep-agent-key'], confirmExistingKey: values['confirm-existing-key'],
        onProgress: event => { process.stderr.write(JSON.stringify(event) + '\n'); },
      });
      output(result);
      if (!result.ok && result.status !== 'confirmation-required') process.exitCode = 1;
    } else output(await setup(setupOptions));
    return;
  }
  if (values['setup-code-stdin'] || values['replace-agent-key'] || values['keep-agent-key'] || values['confirm-existing-key']) throw new Error('Installation code options are only supported by setup.');
  if (values['dry-run'] || values.npx) throw new Error('--dry-run and --npx are only supported by setup.');
  if (command === 'config') {
    if (!name) throw new Error('Choose a client. Use --help.');
    process.stdout.write(clientConfig(name, { ...options, local: values.local, mode: values.mode })); return;
  }
  if (command === 'skill') {
    if (name === 'install') {
      if (!values.client) throw new Error('skill install requires --client.');
      output(await installSkill({ client: values.client, cwd: values.cwd, global: values.global })); return;
    }
    if (name === 'export') {
      if (!values.output) throw new Error('skill export requires --output PATH.zip.');
      output({ path: await exportSkill(resolve(values.cwd ?? process.cwd(), values.output)) }); return;
    }
    throw new Error('Use skill install or skill export.');
  }
  if (!['serve', 'tools', 'describe', 'call', 'explore', 'doctor'].includes(command)) throw new Error('Unknown command. Use --help.');
  if (['serve', 'doctor'].includes(command) && name) throw new Error('Unexpected positional argument.');
  if (['describe', 'call'].includes(command) && !name) throw new Error(`${command} requires a tool name.`);
  if (values.mode && !['compact', 'full'].includes(values.mode)) throw new Error('Mode must be compact or full.');
  const limit = values.limit === undefined ? 10 : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be an integer from 1 to 100.');
  let args: Record<string, unknown> = {};
  if (command === 'explore') {
    if (!name?.trim()) throw new Error('explore requires one quoted command, for example: explore --workspace 123 "ls /".');
    if (!values.workspace || !/^\d+$/.test(values.workspace) || !Number.isSafeInteger(Number(values.workspace)) || Number(values.workspace) < 1) {
      throw new Error('--workspace must be a positive safe integer.');
    }
    if (values.cursor !== undefined && !values.cursor.trim()) throw new Error('--cursor must be nonempty.');
    if (values['max-chars'] !== undefined && (!/^\d+$/.test(values['max-chars']) || Number(values['max-chars']) < 1 || Number(values['max-chars']) > 16000)) {
      throw new Error('--max-chars must be an integer from 1 to 16000.');
    }
    if (values.board !== undefined && (!/^\d+$/.test(values.board) || !Number.isSafeInteger(Number(values.board)) || Number(values.board) < 1)) {
      throw new Error('--board must be a positive safe integer.');
    }
    if (values.archived !== undefined && !['active', 'archived', 'all'].includes(values.archived)) {
      throw new Error('--archived must be active, archived or all.');
    }
    const statuses = values.status?.map(value => {
      if (!value.trim()) throw new Error('--status must be a nonempty option name or positive safe integer ID.');
      if (!/^\d+$/.test(value)) return value;
      if (!Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new Error('--status IDs must be positive safe integers.');
      return Number(value);
    });
    if (statuses && statuses.length > 20) throw new Error('--status accepts at most 20 alternatives.');
    for (const option of ['json', 'file', 'stdin', 'limit', 'output', 'connect', 'client', 'global', 'local', 'mode'] as const) {
      if (values[option] !== undefined) throw new Error(`--${option} is not supported by explore.`);
    }
    args = { workspaceId: Number(values.workspace), command: name,
      ...(values.cursor !== undefined ? { cursor: values.cursor } : {}),
      ...(values['max-chars'] !== undefined ? { maxChars: Number(values['max-chars']) } : {}),
      ...(values.board !== undefined ? { boardId: Number(values.board) } : {}),
      ...(statuses !== undefined ? { status: statuses.length === 1 ? statuses[0] : statuses } : {}),
      ...(values.archived !== undefined ? { archived: values.archived } : {}),
      ...(values['include-relations'] !== undefined ? { includeRelations: values['include-relations'] } : {}),
    };
  }
  if (command === 'call') {
    if ([values.json !== undefined, values.file !== undefined, values.stdin === true].filter(Boolean).length > 1) throw new Error('Choose only one of --json, --file, or --stdin.');
    const source = values.json ?? (values.file !== undefined ? await readFile(resolve(values.cwd ?? process.cwd(), values.file), 'utf8') : values.stdin ? await stdinText() : '{}');
    if (Buffer.byteLength(source) > 7 * 1024 * 1024) throw new Error('JSON input exceeds 7 MiB.');
    try { args = JSON.parse(source); } catch { throw new Error('Invalid JSON arguments.'); }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object.');
  }
  if (command === 'serve' && values.client) {
    const refreshed = await refreshManagedSetup({ ...options, client: values.client, mode: values.mode, local: values.local });
    if (refreshed.status === 'blocked') process.stderr.write(JSON.stringify({ type: 'steercards-update', status: 'blocked', message: 'Automatic update could not complete. Review the managed config, skill, permissions and setup lock, then rerun latest setup if needed. MCP startup will continue.' }) + '\n');
    else if (refreshed.status === 'updated') process.stderr.write(JSON.stringify({ type: 'steercards-update', status: 'updated', version: packageInfo.version, ...(refreshed.desktopSkillUploadRequired ? { message: 'The skill ZIP was updated. Upload it again in Claude Desktop skill settings.' } : {}) }) + '\n');
  }
  const config = await loadConfig(options);
  secret = config.agentKey;
  if (command === 'doctor' && !values.connect) {
    output({ ok: true, cwd: config.cwd, envFile: config.envFile, url: config.url, keySource: config.keySource, keyPresent: true, connected: false }); return;
  }
  const runtime = new Runtime(config);
  if (command === 'serve') {
    const server = await startServer(runtime, { mode: (values.mode ?? 'compact') as 'compact' | 'full' });
    let closing = false;
    const close = async () => { if (closing) return; closing = true; await server.close(); await runtime.close(); };
    process.once('SIGINT', () => { void close(); });
    process.once('SIGTERM', () => { void close(); });
    return;
  }
  try {
    if (command === 'tools') {
      output(name ? await runtime.searchTools(name, limit) : (await runtime.listTools()).map(tool => ({ name: tool.name, description: tool.description?.split('\n')[0] }))); return;
    }
    if (command === 'describe') { output(await runtime.describeTool(name)); return; }
    if (command === 'doctor') {
      const catalog = await runtime.listTools();
      const result = await runtime.callTool('list_workspaces', {});
      output({ ok: !isFailure(result), connected: !isFailure(result), toolCount: catalog.length, keySource: config.keySource, result });
      if (isFailure(result)) process.exitCode = 1;
      return;
    }
    const result = await runtime.callTool(command === 'explore' ? 'explore_cards' : name, args);
    output(result);
    if (isFailure(result)) process.exitCode = 1;
  } finally { await runtime.close(); }
}
main().catch(error => {
  const message = error instanceof Error ? error.message : 'Unexpected failure.';
  const safe = secret ? message.split(secret).join('[REDACTED]') : message;
  process.stderr.write(JSON.stringify({ ok: false, error: safe }) + '\n');
  process.exitCode = 1;
});
