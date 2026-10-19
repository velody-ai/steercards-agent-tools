#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { Runtime } from './runtime.js';
import { startServer } from './server.js';
import { clientConfig, installSkill, exportSkill, packageInfo } from './install.js';

const help = `Steercards agent tools ${packageInfo.version}

steercards serve [--mode compact|full]
steercards tools [query] [--limit 10]
steercards describe NAME
steercards call NAME [--json JSON | --file PATH | --stdin]
steercards doctor [--connect]
steercards config CLIENT [--local] [--mode compact|full]
steercards skill install --client CLIENT [--global]
steercards skill export --output PATH.zip

Connection options: --cwd PATH --env-file PATH --url URL
Default .env: exactly --cwd/.env (otherwise current directory).
Environment: STEERCARDS_AGENT_KEY, optional STEERCARDS_MCP_URL.
Clients: claude-code, codex, codex-app, codex-cli, cursor, claude-desktop.
config prints a snippet; it never edits host settings or includes the key.
--local uses this installation's absolute Node/CLI paths (works before npm release).
Claude Desktop: upload the skill ZIP, use compact get_guide, or full guide resources.
Full tool responses are JSON; tool/product errors exit nonzero. Writes are never retried.
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

let secret = process.env.STEERCARDS_AGENT_KEY;
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    cwd: { type: 'string' }, 'env-file': { type: 'string' }, url: { type: 'string' }, mode: { type: 'string' },
    json: { type: 'string' }, file: { type: 'string' }, stdin: { type: 'boolean' },
    client: { type: 'string' }, global: { type: 'boolean' }, output: { type: 'string' },
    limit: { type: 'string' }, connect: { type: 'boolean' }, local: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  if (values.version) { process.stdout.write(packageInfo.version + '\n'); return; }
  if (values.help || positionals.length === 0) { process.stdout.write(help); return; }
  const [command, name, ...extra] = positionals;
  const options = { cwd: values.cwd, envFile: values['env-file'], url: values.url };
  if (extra.length) throw new Error('Unexpected extra arguments. Use --help.');
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
  if (!['serve', 'tools', 'describe', 'call', 'doctor'].includes(command)) throw new Error('Unknown command. Use --help.');
  if (['serve', 'doctor'].includes(command) && name) throw new Error('Unexpected positional argument.');
  if (['describe', 'call'].includes(command) && !name) throw new Error(`${command} requires a tool name.`);
  if (values.mode && !['compact', 'full'].includes(values.mode)) throw new Error('Mode must be compact or full.');
  const limit = values.limit === undefined ? 10 : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be an integer from 1 to 100.');
  let args: Record<string, unknown> = {};
  if (command === 'call') {
    if ([values.json !== undefined, values.file !== undefined, values.stdin === true].filter(Boolean).length > 1) throw new Error('Choose only one of --json, --file, or --stdin.');
    const source = values.json ?? (values.file !== undefined ? await readFile(resolve(values.cwd ?? process.cwd(), values.file), 'utf8') : values.stdin ? await stdinText() : '{}');
    if (Buffer.byteLength(source) > 7 * 1024 * 1024) throw new Error('JSON input exceeds 7 MiB.');
    try { args = JSON.parse(source); } catch { throw new Error('Invalid JSON arguments.'); }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object.');
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
    const result = await runtime.callTool(name, args);
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
