import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { applyEdits, getNodeValue, modify, parseTree, type Node, type ParseError } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { zipSync } from 'fflate';
import { clientConfig, clients, packageInfo, skillRoot } from './install.js';

export interface SetupOptions {
  client: string;
  cwd?: string;
  local?: boolean;
  mode?: string;
  url?: string;
  envFile?: string;
  dryRun?: boolean;
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export interface SetupReport {
  client: string;
  version: string;
  status: 'installed' | 'updated' | 'unchanged' | 'dry-run';
  paths: { config: string; skill?: string; skillZip?: string; manifest: string };
  actions: string[];
  nextSteps: string[];
}

/** Internal dependency injection for isolated upgrade, race, and failure tests. */
export interface SetupDependencies {
  source?: string;
  version?: string;
  beforeCommit?: () => Promise<void>;
  beforeWrite?: (path: string, index: number) => Promise<void>;
}

type ObjectValue = Record<string, unknown>;
type Snapshot = { bytes: Buffer; mode: number } | null;
type Fields = Record<'command' | 'args' | 'type', string>;
interface Manifest {
  schemaVersion: 1;
  client: string;
  version: string;
  options: { cwd: string; local: boolean; mode: string; url?: string; envFile?: string };
  paths: SetupReport['paths'];
  config: { format: 'toml' | 'jsonc'; fields: Fields; blockHash?: string };
  skill: { files: Record<string, string>; zipHash?: string };
}

const startMarker = '# >>> steercards setup managed block >>>';
const endMarker = '# <<< steercards setup managed block <<<';
const fieldNames = ['command', 'args', 'type'] as const;
const absent = 'absent';
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: ObjectValue, name: string) => Object.prototype.hasOwnProperty.call(value, name);
const fields = (value: ObjectValue): Fields => Object.fromEntries(fieldNames.map(name => [name, own(value, name) ? hash(JSON.stringify(value[name])) : absent])) as Fields;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const sameSnapshot = (left: Snapshot, right: Snapshot) => left === null ? right === null : right !== null && left.bytes.equals(right.bytes);

// JSONC deliberately builds null-prototype objects. Compare values, while keeping
// TOML date/time instances intact so their distinct types remain significant.
function semanticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticValue);
  if (object(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value))) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, semanticValue(child)]));
  return value;
}

async function canonicalBase(path: string): Promise<string> {
  const absolute = resolve(path);
  try { return await realpath(absolute); }
  catch (error) {
    if (!missing(error)) throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(await canonicalBase(parent), basename(absolute));
  }
}

async function noSymlink(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Refusing a symbolic link in setup path: ${path}`);
    } catch (error) { if (!missing(error)) throw error; }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function snapshot(path: string): Promise<Snapshot> {
  await noSymlink(path);
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error(`Expected a regular setup file: ${path}`);
    return { bytes: await readFile(path), mode: stat.mode & 0o777 };
  } catch (error) { if (missing(error)) return null; throw error; }
}

async function sourceFiles(root: string, prefix = ''): Promise<Record<string, Buffer>> {
  await noSymlink(root);
  const result: Record<string, Buffer> = {};
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await sourceFiles(root, name));
    else if (entry.isFile()) result[name] = await readFile(join(root, name));
    else throw new Error('Skill source must contain only regular files and directories.');
  }
  return result;
}

async function checkSkillTree(path: string): Promise<boolean> {
  await noSymlink(path);
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory()) throw new Error(`Expected a skill directory: ${path}`);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await checkSkillTree(join(path, entry.name));
      else if (!entry.isFile()) throw new Error(`Refusing a symbolic link or special file in skill directory: ${path}`);
    }
    return true;
  } catch (error) { if (missing(error)) return false; throw error; }
}

function parseJsonc(text: string): ObjectValue {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (!tree || errors.length || tree.type !== 'object') throw new Error('Client configuration must be a valid JSON/JSONC object. Fix its syntax and retry setup.');
  function unique(node: Node): void {
    if (node.type === 'object') {
      const keys = new Set<string>();
      for (const child of node.children ?? []) {
        const key = child.children?.[0]?.value as string;
        if (keys.has(key)) throw new Error('Client configuration contains duplicate JSON keys. Resolve them and retry setup.');
        keys.add(key);
      }
    }
    for (const child of node.children ?? []) unique(child);
  }
  unique(tree);
  return getNodeValue(tree) as ObjectValue;
}

function parseConfig(text: string, toml: boolean): ObjectValue {
  if (!toml) return parseJsonc(text);
  try { return parseToml(text) as ObjectValue; }
  catch { throw new Error('Client configuration must be valid TOML without duplicate tables or fields. Fix its syntax and retry setup.'); }
}

function serverFrom(config: ObjectValue, key: string): ObjectValue | undefined {
  if (!own(config, key)) return undefined;
  if (!object(config[key])) throw new Error(`Client configuration ${key} must be an object/table.`);
  const servers = config[key];
  if (!own(servers, 'steercards')) return undefined;
  if (!object(servers.steercards)) throw new Error('Existing steercards MCP configuration must be an object/table. Move or fix it before setup.');
  return servers.steercards;
}

function changedConfiguration(text: string, original: ObjectValue, generatedText: string, desired: ObjectValue, toml: boolean, previous?: Manifest): { text: string; blockHash?: string } {
  const key = toml ? 'mcp_servers' : 'mcpServers';
  const current = serverFrom(original, key);
  const currentFields = fields(current ?? {});
  if (previous) {
    if (!current || !isDeepStrictEqual(currentFields, previous.config.fields)) throw new Error('Managed steercards MCP fields were changed. Restore them from your setup version or move the configuration before retrying; no files were changed.');
  } else if (current && !isDeepStrictEqual(currentFields, fields(desired))) {
    throw new Error('An unmanaged steercards MCP configuration differs from this setup. Review and move its entry before retrying; no files were changed.');
  }
  let result: string;
  let blockHash: string | undefined;
  if (toml) {
    const block = `${startMarker}\n${generatedText.trimEnd()}\n${endMarker}\n`;
    blockHash = hash(block);
    if (previous) {
      const start = text.indexOf(`${startMarker}\n`);
      const end = text.indexOf(`${endMarker}\n`, start);
      if (start < 0 || end < 0 || text.indexOf(startMarker, start + startMarker.length) >= 0 || text.indexOf(endMarker, end + endMarker.length) >= 0) throw new Error('The managed steercards TOML block was changed or is ambiguous. Restore its markers before retrying; no files were changed.');
      const oldBlock = text.slice(start, end + endMarker.length + 1);
      if (hash(oldBlock) !== previous.config.blockHash) throw new Error('The managed steercards TOML block was edited. Restore it or move the entry before retrying; no files were changed.');
      result = text.slice(0, start) + block + text.slice(end + endMarker.length + 1);
    } else {
      if (text.includes(startMarker) || text.includes(endMarker)) throw new Error('Unmanaged steercards setup markers already exist. Review and move the block before retrying.');
      if (current) {
        const start = text.indexOf(generatedText);
        if (start < 0 || text.indexOf(generatedText, start + generatedText.length) >= 0) throw new Error('Existing steercards TOML matches the server but has unmanaged formatting. Move its table or use the exact generated config before retrying setup.');
        result = text.slice(0, start) + block + text.slice(start + generatedText.length);
      } else result = text + (text ? (text.endsWith('\n') ? '\n' : '\n\n') : '') + block;
    }
  } else {
    result = text;
    const formattingOptions = { insertSpaces: !/^\t+/m.test(text), tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' };
    if (!current) result = applyEdits(result, modify(result, [key, 'steercards'], desired, { formattingOptions }));
    else for (const name of fieldNames) {
      if (isDeepStrictEqual(current[name], desired[name]) && own(current, name) === own(desired, name)) continue;
      result = applyEdits(result, modify(result, [key, 'steercards', name], desired[name], { formattingOptions }));
    }
    if (!result.endsWith('\n')) result += '\n';
  }
  const expected = { ...original };
  const updated = { ...(current ?? {}) };
  for (const name of fieldNames) {
    if (own(desired, name)) updated[name] = desired[name];
    else delete updated[name];
  }
  expected[key] = { ...(original[key] as ObjectValue | undefined), steercards: updated };
  if (!isDeepStrictEqual(semanticValue(parseConfig(result, toml)), semanticValue(expected))) throw new Error('Setup could not preserve the existing client configuration safely. Move the steercards entry and retry; no files were changed.');
  return { text: result, blockHash };
}

function readManifest(bytes: Buffer, client: string, paths: SetupReport['paths']): Manifest {
  let value: Manifest;
  try { value = JSON.parse(bytes.toString('utf8')) as Manifest; }
  catch { throw new Error('Setup manifest is invalid. Review or move it before retrying.'); }
  if (!object(value) || value.schemaVersion !== 1 || value.client !== client || typeof value.version !== 'string' || !isDeepStrictEqual(value.paths, paths) || !object(value.options) || typeof value.options.local !== 'boolean' || typeof value.options.mode !== 'string' || value.options.cwd !== dirname(dirname(dirname(paths.manifest))) || !object(value.config) || !object(value.config.fields) || !object(value.skill) || !object(value.skill.files)) throw new Error('Setup manifest does not match this installation. Review or move it before retrying.');
  for (const name of fieldNames) if (typeof value.config.fields[name] !== 'string') throw new Error('Setup manifest has invalid configuration ownership.');
  if (value.config.format !== (client === 'codex' ? 'toml' : 'jsonc') || (client === 'codex' && typeof value.config.blockHash !== 'string')) throw new Error('Setup manifest has invalid configuration ownership.');
  for (const [path, digest] of Object.entries(value.skill.files)) {
    if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || typeof digest !== 'string') throw new Error('Setup manifest has invalid skill ownership.');
  }
  if (value.options.url !== undefined && typeof value.options.url !== 'string' || value.options.envFile !== undefined && typeof value.options.envFile !== 'string') throw new Error('Setup manifest has invalid options.');
  return value;
}

async function atomicWrite(path: string, data: Buffer, mode: number, ensureDirectory: (path: string) => Promise<void>): Promise<void> {
  await ensureDirectory(dirname(path));
  await noSymlink(path);
  const stage = join(dirname(path), `.${basename(path)}.steercards-${randomUUID()}.tmp`);
  try {
    await writeFile(stage, data, { flag: 'wx', mode });
    await rename(stage, path);
  } finally { await rm(stage, { force: true }); }
}

/** Configure MCP and the matching skill together, preserving unrelated client data. */
export async function setup(options: SetupOptions, dependencies: SetupDependencies = {}): Promise<SetupReport> {
  if (!clients.includes(options.client as typeof clients[number])) throw new Error(`Unknown client. Choose ${clients.join(', ')}.`);
  const client = options.client.startsWith('codex') ? 'codex' : options.client;
  const cwd = await canonicalBase(options.cwd ?? process.cwd());
  const version = dependencies.version ?? packageInfo.version;
  const toml = client === 'codex';
  let configPath: string;
  let skillPath: string | undefined;
  let zipPath: string | undefined;
  if (client === 'claude-desktop') {
    const platform = options.platform ?? process.platform;
    if (platform !== 'darwin' && platform !== 'win32') throw new Error('Claude Desktop setup supports macOS and Windows. Choose a supported client on this platform.');
    const home = await canonicalBase(options.home ?? homedir());
    const base = platform === 'darwin' ? join(home, 'Library', 'Application Support') : await canonicalBase((options.env ?? process.env).APPDATA ?? join(home, 'AppData', 'Roaming'));
    configPath = join(base, 'Claude', 'claude_desktop_config.json');
    zipPath = join(cwd, '.steercards', 'steercards-skill.zip');
  } else {
    const directory = client === 'codex' ? '.codex' : client === 'claude-code' ? '.claude' : '.cursor';
    configPath = client === 'claude-code' ? join(cwd, '.mcp.json') : join(cwd, directory, toml ? 'config.toml' : 'mcp.json');
    skillPath = join(cwd, client === 'codex' ? '.agents' : directory, 'skills', 'steercards');
  }
  const paths: SetupReport['paths'] = { config: configPath, ...(skillPath ? { skill: skillPath } : { skillZip: zipPath }), manifest: join(cwd, '.steercards', 'setup', `${client}.json`) };
  const lockPath = `${configPath}.steercards-setup.lock`;
  const baselines = new Map<string, Snapshot>();
  const remember = async (path: string): Promise<Snapshot> => {
    if (!baselines.has(path)) baselines.set(path, await snapshot(path));
    return baselines.get(path)!;
  };
  await noSymlink(lockPath);
  const manifestBefore = await remember(paths.manifest);
  const previous = manifestBefore ? readManifest(manifestBefore.bytes, client, paths) : undefined;
  const effective = {
    cwd,
    local: options.local ?? previous?.options.local ?? false,
    mode: options.mode ?? previous?.options.mode ?? 'compact',
    ...((options.url ?? previous?.options.url) !== undefined ? { url: options.url ?? previous?.options.url } : {}),
    ...((options.envFile ?? previous?.options.envFile) !== undefined ? { envFile: resolve(cwd, (options.envFile ?? previous?.options.envFile)!) } : {}),
  };
  let generatedText = clientConfig(client, effective);
  if (version !== packageInfo.version && !effective.local) generatedText = generatedText.replace(`${packageInfo.name}@${packageInfo.version}`, `${packageInfo.name}@${version}`);
  const desired = serverFrom(parseConfig(generatedText, toml), toml ? 'mcp_servers' : 'mcpServers')!;
  const configBefore = await remember(configPath);
  const configText = configBefore?.bytes.toString('utf8') ?? (toml ? '' : '{}\n');
  const original = parseConfig(configText, toml);
  const configAfter = changedConfiguration(configText, original, generatedText, desired, toml, previous);
  const files = await sourceFiles(await canonicalBase(dependencies.source ?? skillRoot));
  if (!files['SKILL.md']) throw new Error('Skill source is missing SKILL.md.');
  const fileHashes = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)]));
  const plan = new Map<string, Buffer | null>();
  plan.set(configPath, Buffer.from(configAfter.text));
  if (skillPath) {
    const exists = await checkSkillTree(skillPath);
    if (previous) {
      for (const [name, digest] of Object.entries(previous.skill.files)) {
        const before = await remember(join(skillPath, name));
        if (!before || hash(before.bytes) !== digest) throw new Error(`Managed skill file was changed or removed: ${name}. Restore it or move the skill directory before retrying; no files were changed.`);
        if (!own(files, name)) plan.set(join(skillPath, name), null);
      }
    }
    for (const [name, bytes] of Object.entries(files)) {
      const target = join(skillPath, name);
      const before = await remember(target);
      if (before && (!previous || !own(previous.skill.files, name)) && !before.bytes.equals(bytes)) throw new Error(`An unmanaged skill file differs: ${name}. Review and move the skill directory before retrying; no files were changed.`);
      if (exists && !previous && !before) throw new Error(`Existing skill is incomplete: ${name}. Review and move the skill directory before retrying; no files were changed.`);
      plan.set(target, bytes);
    }
  }
  let zipHash: string | undefined;
  if (zipPath) {
    const entries = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [`steercards/${name}`, [bytes, { mtime: new Date(1980, 0, 1) }] as [Uint8Array, { mtime: Date }]]));
    const zip = Buffer.from(zipSync(entries));
    zipHash = hash(zip);
    const before = await remember(zipPath);
    if (previous ? !before || hash(before.bytes) !== previous.skill.zipHash : before && !before.bytes.equals(zip)) throw new Error('The existing skill ZIP differs from the managed version. Review and move it before retrying; no files were changed.');
    plan.set(zipPath, zip);
  }
  const manifest: Manifest = { schemaVersion: 1, client, version, options: effective, paths, config: { format: toml ? 'toml' : 'jsonc', fields: fields(desired), ...(configAfter.blockHash ? { blockHash: configAfter.blockHash } : {}) }, skill: { files: fileHashes, ...(zipHash ? { zipHash } : {}) } };
  plan.set(paths.manifest, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  for (const [path, bytes] of plan) {
    const before = await remember(path);
    if (bytes === null ? before === null : before?.bytes.equals(bytes)) plan.delete(path);
  }
  const actions = [...plan].map(([path, bytes]) => `${bytes === null ? 'remove' : baselines.get(path) ? 'update' : 'create'} ${path}`);
  const nextSteps = client === 'claude-desktop'
    ? [`Restart Claude Desktop to load the MCP server.`, `Upload ${zipPath} in Claude's skill settings. Repeat the upload after a skill update.`, 'Set STEERCARDS_AGENT_KEY in the project .env or the referenced env file before using MCP.']
    : ['Restart or reload your client to load the MCP server and skill.', 'Set STEERCARDS_AGENT_KEY in the project .env or the referenced env file before using MCP.'];
  const report: SetupReport = { client, version, status: options.dryRun ? 'dry-run' : plan.size ? previous ? 'updated' : 'installed' : 'unchanged', paths, actions, nextSteps };
  if (options.dryRun || !plan.size) return report;

  // This is an ordinary-failure transaction, not a crash-atomic multi-file commit.
  const createdDirectories: string[] = [];
  async function ensureDirectory(path: string): Promise<void> {
    await noSymlink(path);
    try {
      if (!(await lstat(path)).isDirectory()) throw new Error(`Expected a setup directory: ${path}`);
      return;
    } catch (error) { if (!missing(error)) throw error; }
    await ensureDirectory(dirname(path));
    try { await mkdir(path, { mode: 0o700 }); createdDirectories.push(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await noSymlink(path); if (!(await lstat(path)).isDirectory()) throw new Error(`Expected a setup directory: ${path}`); }
  }
  let locked = false;
  const attempted: string[] = [];
  try {
    await ensureDirectory(dirname(lockPath));
    try { await writeFile(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); locked = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Another setup holds ${lockPath}. Wait for it to finish; remove a stale lock only after checking no setup is running.`);
      throw error;
    }
    await dependencies.beforeCommit?.();
    for (const [path, before] of baselines) {
      const now = await snapshot(path);
      if (!sameSnapshot(before, now)) throw new Error('A setup destination changed during preflight. Retry after reviewing the client configuration and skill; no files were changed.');
    }
    if (skillPath) await checkSkillTree(skillPath);
    let index = 0;
    for (const [path, bytes] of plan) {
      await dependencies.beforeWrite?.(path, index++);
      if (!sameSnapshot(baselines.get(path)!, await snapshot(path))) throw new Error('A setup destination changed before writing. Retry after reviewing the client configuration and skill.');
      attempted.push(path);
      if (bytes === null) { await noSymlink(path); await rm(path); }
      else await atomicWrite(path, bytes, baselines.get(path)?.mode ?? 0o600, ensureDirectory);
    }
  } catch (error) {
    let rollbackFailed = false;
    for (const path of attempted.reverse()) {
      const before = baselines.get(path);
      try {
        const now = await snapshot(path);
        if (sameSnapshot(before!, now)) continue;
        const intended = plan.get(path)!;
        if (intended === null ? now !== null : now === null || !now.bytes.equals(intended)) {
          // A non-cooperating editor changed a file after our write. Preserve it.
          rollbackFailed = true;
          continue;
        }
        if (before) await atomicWrite(path, before.bytes, before.mode, ensureDirectory);
        else { await noSymlink(path); await rm(path, { force: true }); }
      } catch { rollbackFailed = true; }
    }
    if (rollbackFailed) throw new Error('Setup failed and rollback could not restore every file. Review the client config, skill, and setup manifest before retrying.');
    throw error;
  } finally {
    if (locked) await rm(lockPath, { force: true });
    for (const path of createdDirectories.reverse()) {
      try { await rmdir(path); }
      catch (error) { if (!missing(error) && !['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
  }
  return report;
}
