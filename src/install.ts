import { readFile, readdir, mkdir, lstat, rename, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { zipSync } from 'fflate';
import { validateMcpUrl } from './config.js';
import { packageRoot, packageInfo } from './package.js';

export { packageRoot, packageInfo } from './package.js';
export const skillRoot = join(packageRoot, 'skills', 'steercards');
export const clients = ['claude-code', 'codex', 'codex-app', 'codex-cli', 'cursor', 'claude-desktop'] as const;
export type Client = typeof clients[number];

export function clientConfig(client: string, options: { cwd?: string; local?: boolean; mode?: string; url?: string; envFile?: string } = {}): string {
  if (!clients.includes(client as Client)) throw new Error(`Unknown client. Choose ${clients.join(', ')}.`);
  const mode = options.mode ?? 'compact';
  if (!['compact', 'full'].includes(mode)) throw new Error('Mode must be compact or full.');
  const cwd = resolve(options.cwd ?? process.cwd());
  const args = options.local ? [join(packageRoot, 'dist', 'cli.js')] : ['-y', `${packageInfo.name}@${packageInfo.version}`];
  args.push('serve', '--cwd', cwd, '--mode', mode);
  if (options.envFile) args.push('--env-file', resolve(cwd, options.envFile));
  if (options.url) {
    args.push('--url', validateMcpUrl(options.url));
  }
  const command = options.local ? process.execPath : 'npx';
  if (client.startsWith('codex')) return `[mcp_servers.steercards]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n`;
  return JSON.stringify({ mcpServers: { steercards: { ...(client === 'cursor' ? { type: 'stdio' } : {}), command, args } } }, null, 2) + '\n';
}

async function skillFiles(root: string, prefix = ''): Promise<Record<string, Uint8Array>> {
  const result: Record<string, Uint8Array> = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await skillFiles(root, path));
    else if (entry.isFile()) result[path] = await readFile(join(root, path));
    else throw new Error('Skill source must contain only regular files and directories.');
  }
  return result;
}

async function assertNoSymlink(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Refusing to install through a symbolic link.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function installSkill(options: { client: string; cwd?: string; global?: boolean; home?: string; source?: string }): Promise<{ path: string; status: 'installed' | 'unchanged' }> {
  const dirs: Record<string, string> = { 'claude-code': '.claude', codex: '.agents', 'codex-cli': '.agents', 'codex-app': '.agents', cursor: '.cursor' };
  const dir = dirs[options.client];
  if (!dir) throw new Error('For Claude Desktop use skill export and upload the ZIP, or read steercards_get_guide through MCP.');
  const base = options.global ? (options.home ?? homedir()) : resolve(options.cwd ?? process.cwd());
  const target = join(base, dir, 'skills', 'steercards');
  await assertNoSymlink(target);
  const files = await skillFiles(options.source ?? skillRoot);
  try {
    const existing = await skillFiles(target);
    if (Object.keys(existing).length === Object.keys(files).length && Object.entries(files).every(([name, data]) => existing[name] && Buffer.from(data).equals(existing[name]))) return { path: target, status: 'unchanged' };
    throw new Error(`Existing skill differs at ${target}. Review and remove or move that directory before reinstalling.`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(dirname(target), { recursive: true });
  const stage = await mkdtemp(join(dirname(target), '.steercards-'));
  try {
    for (const [name, data] of Object.entries(files)) {
      await mkdir(dirname(join(stage, name)), { recursive: true });
      await writeFile(join(stage, name), data, { flag: 'wx' });
    }
    // Reject races with existing installs, including an empty directory.
    try { await lstat(target); throw new Error('Skill destination was created during installation; retry after reviewing it.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(stage, target);
  } finally { await rm(stage, { recursive: true, force: true }); }
  return { path: target, status: 'installed' };
}

export async function exportSkill(output: string, source = skillRoot): Promise<string> {
  const files = await skillFiles(source);
  const entries = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [`steercards/${name}`, bytes]));
  const target = resolve(output);
  await writeFile(target, zipSync(entries), { flag: 'wx' });
  return target;
}
