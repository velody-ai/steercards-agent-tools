import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, open, readFile, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'dotenv';

const exec = promisify(execFile);
const keyName = 'STEERCARDS_AGENT_KEY';
const keyPattern = /^sc_agent_[A-Za-z0-9_-]{43}$/;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
type Snapshot = Buffer | null;

export interface CredentialOptions {
  cwd?: string;
  envFile?: string;
  savedEnvFile?: string;
  replaceAgentKey?: boolean;
  keepAgentKey?: boolean;
  rejectEmptyAgentKey?: boolean;
  dryRun?: boolean;
}

/** Holds only nonsecret metadata in enumerable properties. */
export interface ProjectCredentials {
  cwd: string;
  envFile: string;
  needsExchange: boolean;
  actions: string[];
  verify(): Promise<void>;
  protect(): Promise<void>;
  save(token: string): Promise<void>;
  readKey(): Promise<string>;
  readMcpUrl(): Promise<string | undefined>;
  close(): Promise<void>;
}

async function noSymlink(path: string): Promise<void> {
  let current = path;
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Setup refuses a symbolic link in a credential path.'); }
    catch (error) { if (!missing(error)) throw error; }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function snapshot(path: string): Promise<Snapshot> {
  await noSymlink(path);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Credential and ignore files must be ordinary, unlinked files.');
    if (stat.size > 1024 * 1024) throw new Error('Credential or ignore file is too large to update safely.');
    const bytes = await readFile(path);
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('Credential and ignore files must use UTF-8.'); }
    return bytes;
  } catch (error) { if (missing(error)) return null; throw error; }
}

const same = (left: Snapshot, right: Snapshot) => left === null ? right === null : right !== null && left.equals(right);
const eol = (text: string) => text.includes('\r\n') ? '\r\n' : '\n';

/** Locate assignments without mistaking lines inside another multiline value for keys. */
function keyValue(text: string): { start: number; end: number; value: string } | undefined {
  const assignments: { start: number; end: number; value: string }[] = [];
  let offset = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (offset < text.length) {
    const lineEnd = text.indexOf('\n', offset);
    const end = lineEnd < 0 ? text.length : lineEnd;
    const line = text.slice(offset, end).replace(/\r$/, '');
    const match = /^([ \t]*(?:export[ \t]+)?([\w.-]+)[ \t]*(?:=[ \t]*|:[ \t]+))(.*)$/.exec(line);
    if (!match) { offset = lineEnd < 0 ? text.length : lineEnd + 1; continue; }
    const start = offset + match[1].length;
    let valueEnd = start;
    const quote = text[start];
    if (["'", '"', '`'].includes(quote)) {
      valueEnd = start + 1;
      let closed = false;
      for (; valueEnd < text.length; valueEnd++) {
        if (text[valueEnd] !== quote) continue;
        let slashes = 0;
        for (let i = valueEnd - 1; i > start && text[i] === '\\'; i--) slashes++;
        if (slashes % 2 === 0) { valueEnd++; closed = true; break; }
      }
      if (!closed) throw new Error('Environment file contains an unterminated quoted value. Review it before setup.');
      const tailEnd = text.indexOf('\n', valueEnd);
      const tail = text.slice(valueEnd, tailEnd < 0 ? text.length : tailEnd).replace(/\r$/, '');
      if (!/^[ \t]*(?:#.*)?$/.test(tail)) throw new Error('Environment file contains an ambiguous quoted assignment. Review it before setup.');
      offset = tailEnd < 0 ? text.length : tailEnd + 1;
    } else {
      const comment = match[3].indexOf('#');
      valueEnd = start + (comment < 0 ? match[3] : match[3].slice(0, comment)).trimEnd().length;
      offset = lineEnd < 0 ? text.length : lineEnd + 1;
    }
    if (match[2] === keyName) {
      if (/[\r\n]/.test(text.slice(start, valueEnd))) throw new Error('A multiline Agent Key assignment cannot be replaced automatically.');
      const value = parse(`${keyName}=${text.slice(start, valueEnd)}`)[keyName] ?? '';
      if (/\s/.test(value)) throw new Error('The existing Agent Key is invalid. Review its environment assignment before setup.');
      assignments.push({ start, end: valueEnd, value });
    }
  }
  if (assignments.length > 1) throw new Error('Environment file contains duplicate Agent Key assignments. Resolve them before setup.');
  return assignments[0];
}

function withKey(text: string, token: string): string {
  const assignment = keyValue(text);
  if (assignment) return text.slice(0, assignment.start) + token + text.slice(assignment.end);
  return text + (text && !text.endsWith('\n') ? eol(text) : '') + `${keyName}=${token}${eol(text)}`;
}

function withIgnore(text: string): string {
  const patterns = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trimEnd()).filter(line => line && !line.startsWith('#'));
  if (patterns.at(-2) === '/.env' && patterns.at(-1) === '/.steercards/') return text;
  const newline = eol(text);
  return text + (text && !text.endsWith('\n') ? newline : '') + `# Steercards local credentials${newline}/.env${newline}/.steercards/${newline}`;
}

/** Git's index takes precedence over ignore rules; never put a new secret in a tracked file. */
async function assertUntracked(cwd: string): Promise<void> {
  let current = cwd;
  let repository = false;
  while (true) {
    try { await lstat(join(current, '.git')); repository = true; break; }
    catch (error) { if (!missing(error)) throw new Error('Unable to inspect Git tracking before setup.'); }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!repository) return;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  let output: string;
  try { ({ stdout: output } = await exec('git', ['-C', cwd, 'ls-files', '-z', '--', ':(icase,literal).env'], { env, timeout: 10000, maxBuffer: 64 * 1024 })); }
  catch { throw new Error('Unable to verify Git tracking. Install Git or resolve the repository error before setup.'); }
  if (output) throw new Error('The project .env is tracked by Git. Stop tracking it yourself before installing credentials.');
}

async function atomicWrite(path: string, bytes: Buffer, mode = 0o600): Promise<void> {
  await noSymlink(path);
  const stage = join(dirname(path), `.steercards-${randomUUID()}.tmp`);
  try {
    const file = await open(stage, 'wx', mode);
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    await rename(stage, path);
  } finally { await rm(stage, { force: true }); }
}

async function projectEnvironment(options: CredentialOptions): Promise<{ cwd: string; envFile: string }> {
  let cwd: string;
  try {
    cwd = await realpath(resolve(options.cwd ?? process.cwd()));
    if (!(await lstat(cwd)).isDirectory()) throw new Error();
  } catch { throw new Error('The selected project directory must already exist.'); }
  const envFile = join(cwd, '.env');
  if (options.envFile !== undefined && resolve(cwd, options.envFile) !== envFile) throw new Error('Automatic credentials only support the project .env. Use --env-file .env.');
  if (options.envFile === undefined && options.savedEnvFile !== undefined && resolve(cwd, options.savedEnvFile) !== envFile) throw new Error('This installation uses another environment file. Explicitly select --env-file .env to switch before redeeming a code.');
  return { cwd, envFile };
}

/** Read-only discovery before setup creates locks, directories, probes or configuration. */
export async function inspectProjectAgentKey(options: CredentialOptions = {}): Promise<{ cwd: string; envFile: string; hasAgentKey: boolean }> {
  const { cwd, envFile } = await projectEnvironment(options);
  const assignment = keyValue((await snapshot(envFile))?.toString('utf8') ?? '');
  if (assignment && !assignment.value) throw new Error('The project .env contains an empty Agent Key assignment. Review it before setup; no code was exchanged.');
  return { cwd, envFile, hasAgentKey: Boolean(assignment?.value) };
}

/** Preflight local credentials while holding a project lock shared by every client. */
export async function prepareProjectCredentials(options: CredentialOptions = {}): Promise<ProjectCredentials> {
  if (options.keepAgentKey && options.replaceAgentKey) throw new Error('Choose only one of --keep-agent-key or --replace-agent-key.');
  const { cwd, envFile } = await projectEnvironment(options);
  const ignoreFile = join(cwd, '.gitignore');
  const lockPath = join(cwd, '.steercards', 'setup', 'credentials.lock');
  const created: string[] = [];
  let locked = false;
  let closed = false;
  const lockBytes = Buffer.from(`${process.pid}:${randomUUID()}\n`);
  const ensureDirectory = async (path: string): Promise<void> => {
    await noSymlink(path);
    try { if (!(await lstat(path)).isDirectory()) throw new Error('Expected a setup directory.'); return; }
    catch (error) { if (!missing(error)) throw error; }
    await ensureDirectory(dirname(path));
    try { await mkdir(path, { mode: 0o700 }); created.push(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await noSymlink(path); if (!(await lstat(path)).isDirectory()) throw new Error('Expected a setup directory.'); }
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    if (locked && same(lockBytes, await snapshot(lockPath))) await rm(lockPath);
    for (const path of created.reverse()) {
      try { await rmdir(path); }
      catch (error) { if (!missing(error) && !['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
  };
  try {
    await noSymlink(lockPath);
    if (!options.dryRun) {
      await ensureDirectory(dirname(lockPath));
      try {
        const file = await open(lockPath, 'wx', 0o600);
        locked = true;
        try { await file.writeFile(lockBytes); } finally { await file.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another setup holds the project credential lock. Wait for it to finish.');
        throw new Error('Unable to acquire the project credential lock. Check directory permissions.');
      }
    }
    let envBefore = await snapshot(envFile);
    let ignoreBefore = await snapshot(ignoreFile);
    const assignment = keyValue(envBefore?.toString('utf8') ?? '');
    const existing = assignment?.value;
    if (options.rejectEmptyAgentKey && assignment && !existing) throw new Error('The project .env contains an empty Agent Key assignment. Review it before setup; no code was exchanged.');
    if (options.keepAgentKey && !existing) throw new Error('The project .env no longer contains an Agent Key. Review the file and choose again; no code was exchanged.');
    if (options.keepAgentKey && !keyPattern.test(existing!)) throw new Error('The existing Agent Key has an invalid format. Review the project .env; no code was exchanged.');
    const needsExchange = !existing || options.replaceAgentKey === true;
    const ignoreAfter = Buffer.from(withIgnore(ignoreBefore?.toString('utf8') ?? ''));
    const ignoreMode = ignoreBefore ? (await lstat(ignoreFile)).mode & 0o777 : 0o644;
    if (needsExchange && envBefore && ((await lstat(envFile)).mode & 0o200) === 0) throw new Error('The project environment file is read-only. Change its permissions before setup.');
    if (!same(ignoreBefore, ignoreAfter) && ignoreBefore && (ignoreMode & 0o200) === 0) throw new Error('The project ignore file is read-only. Change its permissions before setup.');
    await assertUntracked(cwd);
    const verify = async () => {
      if (closed) throw new Error('Credential setup is already closed.');
      await assertUntracked(cwd);
      if (!same(envBefore, await snapshot(envFile)) || !same(ignoreBefore, await snapshot(ignoreFile))) throw new Error('The project environment or ignore file changed during setup. Review it and retry.');
    };
    if (!options.dryRun && (needsExchange || !same(ignoreBefore, ignoreAfter))) {
      // A real same-directory create/rename probe catches permissions before consuming a code.
      const probe = join(cwd, `.steercards-probe-${randomUUID()}.tmp`);
      try { await atomicWrite(probe, Buffer.alloc(0)); }
      catch { throw new Error('The project directory does not allow safe credential writes.'); }
      finally { await rm(probe, { force: true }); }
    }
    const actions = [...(!same(ignoreBefore, ignoreAfter) ? ['protect project .env and .steercards in .gitignore'] : []), ...(needsExchange ? [existing ? 'replace project Agent Key' : 'save project Agent Key'] : ['keep existing project Agent Key'])];
    return {
      cwd, envFile, needsExchange, actions, verify, close,
      async protect() {
        if (options.dryRun) throw new Error('A dry run cannot write files.');
        await verify();
        if (!same(ignoreBefore, ignoreAfter)) { await atomicWrite(ignoreFile, ignoreAfter, ignoreMode); ignoreBefore = ignoreAfter; }
      },
      async save(token) {
        if (options.dryRun) throw new Error('A dry run cannot save credentials.');
        if (!needsExchange) throw new Error('The existing project Agent Key must be preserved.');
        if (!keyPattern.test(token)) throw new Error('The exchanged Agent Key has an invalid format.');
        await verify();
        if (!same(ignoreBefore, ignoreAfter)) throw new Error('Protect the project environment file before saving credentials.');
        const bytes = Buffer.from(withKey(envBefore?.toString('utf8') ?? '', token));
        await atomicWrite(envFile, bytes);
        envBefore = bytes;
      },
      async readKey() {
        await verify();
        const value = keyValue(envBefore?.toString('utf8') ?? '')?.value;
        if (!value) throw new Error('The project environment file has no Agent Key.');
        return value;
      },
      async readMcpUrl() { await verify(); return parse(envBefore?.toString('utf8') ?? '').STEERCARDS_MCP_URL; },
    };
  } catch (error) { await close(); throw error; }
}
