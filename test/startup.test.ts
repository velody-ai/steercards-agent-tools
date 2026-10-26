import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { unzipSync, strFromU8 } from 'fflate';
import { refreshManagedSetup, setup } from '../src/setup.js';
import { skillRoot } from '../src/install.js';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'steercards-startup-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project with spaces'), source = join(root, 'source'), home = join(root, 'home');
  await Promise.all([mkdir(cwd), mkdir(source), mkdir(home)]);
  await writeFile(join(source, 'SKILL.md'), 'Previous skill');
  await writeFile(join(cwd, '.env'), 'STEERCARDS_AGENT_KEY=synthetic-startup-key\n');
  return { root, cwd, source, home };
}

async function tree(root: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await tree(root, name));
    else result[name] = (await readFile(join(root, name))).toString('base64');
  }
  return result;
}

for (const client of ['codex', 'claude-code', 'cursor']) {
  test(`${client}: startup sync upgrades managed skills numerically and preserves unrelated data and credentials`, async t => {
    const { cwd, source } = await fixture(t);
    const options = { client, cwd, mode: 'full', envFile: 'keys.env', url: 'https://steercards.example/api/mcp' };
    const installed = await setup(options, { source, version: '0.1.9' });
    await writeFile(join(installed.paths.skill!, 'user-notes.md'), 'Keep my notes');
    const config = await readFile(installed.paths.config, 'utf8');
    const env = await readFile(join(cwd, '.env'));
    await writeFile(join(source, 'SKILL.md'), 'Current skill');
    let credentialHooks = 0;
    const report = await refreshManagedSetup(options, { source, version: '0.1.10', afterPreflight: async () => { credentialHooks++; } });
    assert.equal(report.status, 'updated');
    assert.equal(await readFile(join(installed.paths.skill!, 'SKILL.md'), 'utf8'), 'Current skill');
    assert.equal(await readFile(join(installed.paths.skill!, 'user-notes.md'), 'utf8'), 'Keep my notes');
    assert.equal(await readFile(installed.paths.config, 'utf8'), config);
    assert.equal(JSON.parse(await readFile(installed.paths.manifest, 'utf8')).version, '0.1.10');
    assert.deepEqual(await readFile(join(cwd, '.env')), env);
    assert.equal(credentialHooks, 0, 'startup must never redeem credentials or run doctor');
    const updated = await tree(cwd);
    assert.equal((await refreshManagedSetup(options, { source, version: '0.1.10' })).status, 'skipped');
    await writeFile(join(source, 'SKILL.md'), 'An older process must not restore this');
    assert.equal((await refreshManagedSetup(options, { source, version: '0.1.9' })).status, 'skipped');
    assert.deepEqual(await tree(cwd), updated);
  });
}

test('startup never creates an installation without a valid managed manifest, or converts a local installation', async t => {
  const { cwd, source } = await fixture(t);
  const options = { client: 'cursor', cwd };
  const bare = await tree(cwd);
  assert.equal((await refreshManagedSetup(options, { source, version: '2.0.0' })).status, 'skipped');
  assert.deepEqual(await tree(cwd), bare);
  const local = await setup({ ...options, local: true }, { source, version: '1.0.0' });
  const before = await tree(cwd);
  await writeFile(join(source, 'SKILL.md'), 'Changed source');
  assert.equal((await refreshManagedSetup(options, { source, version: '2.0.0' })).status, 'skipped');
  assert.deepEqual(await tree(cwd), before);
  await writeFile(local.paths.manifest, '{malformed');
  const malformed = await tree(cwd);
  assert.equal((await refreshManagedSetup(options, { source, version: '2.0.0' })).status, 'blocked');
  assert.deepEqual(await tree(cwd), malformed);
});

test('startup skips unknown/prerelease versions conservatively', async t => {
  const { cwd, source } = await fixture(t);
  const options = { client: 'cursor', cwd };
  const installed = await setup(options, { source, version: '1.0.0' });
  const manifest = JSON.parse(await readFile(installed.paths.manifest, 'utf8'));
  for (const [previous, current] of [['1.0.0', '2.0.0-beta.1'], ['1.0.0-beta.1', '2.0.0'], ['invalid', '2.0.0'], ['01.0.0', '2.0.0']]) {
    await writeFile(installed.paths.manifest, JSON.stringify({ ...manifest, version: previous }));
    const before = await tree(cwd);
    assert.equal((await refreshManagedSetup(options, { source, version: current })).status, 'skipped');
    assert.deepEqual(await tree(cwd), before);
  }
});

test('startup requires matching client, cwd, connection args, paths and the latest command', async t => {
  const { cwd, source, root } = await fixture(t);
  const options = { client: 'cursor', cwd, mode: 'full', url: 'https://steercards.example/api/mcp', envFile: 'keys.env' };
  const installed = await setup(options, { source, version: '1.0.0' });
  await writeFile(join(source, 'SKILL.md'), 'Changed source');
  const before = await tree(cwd);
  for (const changed of [{ mode: 'compact' }, { url: 'https://other.example/api/mcp' }, { envFile: 'other.env' }, { mode: undefined }, { url: undefined }, { envFile: undefined }]) {
    assert.equal((await refreshManagedSetup({ ...options, ...changed }, { source, version: '2.0.0' })).status, 'blocked');
    assert.deepEqual(await tree(cwd), before);
  }
  assert.equal((await refreshManagedSetup({ ...options, client: 'claude-code' }, { source, version: '2.0.0' })).status, 'skipped');
  const other = join(root, 'other'); await mkdir(other);
  assert.equal((await refreshManagedSetup({ ...options, cwd: other }, { source, version: '2.0.0' })).status, 'skipped');
  assert.deepEqual(await readdir(other), []);
  const manifest = JSON.parse(await readFile(installed.paths.manifest, 'utf8'));
  await writeFile(installed.paths.manifest, JSON.stringify({ ...manifest, paths: { ...manifest.paths, skill: other } }));
  const changedPath = await tree(cwd);
  assert.equal((await refreshManagedSetup(options, { source, version: '2.0.0' })).status, 'blocked');
  assert.deepEqual(await tree(cwd), changedPath);
  await writeFile(installed.paths.manifest, JSON.stringify(manifest));
  const config = JSON.parse(await readFile(installed.paths.config, 'utf8'));
  config.mcpServers.steercards.args[2] = '@steercards/agent-tools@1.0.0';
  await writeFile(installed.paths.config, JSON.stringify(config));
  manifest.config.fields.args = createHash('sha256').update(JSON.stringify(config.mcpServers.steercards.args)).digest('hex');
  await writeFile(installed.paths.manifest, JSON.stringify(manifest));
  const pinned = await tree(cwd);
  assert.equal((await refreshManagedSetup(options, { source, version: '2.0.0' })).status, 'blocked');
  assert.deepEqual(await tree(cwd), pinned, 'legacy pinned commands require an explicit setup migration');
});

test('startup preserves edited files and held locks, and rolls back ordinary write failures', async t => {
  const { cwd, source } = await fixture(t);
  const options = { client: 'cursor', cwd };
  const installed = await setup(options, { source, version: '1.0.0' });
  await writeFile(join(source, 'SKILL.md'), 'Current skill');
  const skill = join(installed.paths.skill!, 'SKILL.md');
  await writeFile(skill, 'User edited skill');
  let before = await tree(cwd);
  assert.equal((await refreshManagedSetup(options, { source, version: '2.0.0' })).status, 'blocked');
  assert.deepEqual(await tree(cwd), before);
  await writeFile(skill, 'Previous skill');
  const lock = `${installed.paths.config}.steercards-setup.lock`;
  await writeFile(lock, 'another-process');
  before = await tree(cwd);
  assert.equal((await refreshManagedSetup(options, { source, version: '2.0.0' })).status, 'blocked');
  assert.deepEqual(await tree(cwd), before);
  await rm(lock);
  before = await tree(cwd);
  assert.equal((await refreshManagedSetup(options, { source, version: '2.0.0', beforeWrite: async (_path, index) => { if (index === 1) throw new Error('write failure'); } })).status, 'blocked');
  assert.deepEqual(await tree(cwd), before, 'partial ordinary failure restores managed files and manifest');
});

test('startup keeps a read-only skill intact even when its parent allows rename', async t => {
  const { cwd, source } = await fixture(t);
  const options = { client: 'cursor', cwd };
  const installed = await setup(options, { source, version: '1.0.0' });
  const skill = join(installed.paths.skill!, 'SKILL.md');
  await writeFile(join(source, 'SKILL.md'), 'Current skill');
  await chmod(skill, 0o444);
  try {
    const before = await tree(cwd);
    assert.equal((await refreshManagedSetup(options, { source, version: '2.0.0' })).status, 'blocked');
    assert.deepEqual(await tree(cwd), before);
  } finally { await chmod(skill, 0o600); }
});

test('startup never adopts again after the checked manifest is removed during preflight', async t => {
  const { cwd, source } = await fixture(t);
  const options = { client: 'cursor', cwd };
  const installed = await setup(options, { source, version: '1.0.0' });
  await writeFile(join(source, 'SKILL.md'), 'Current skill');
  const config = await readFile(installed.paths.config), skill = await readFile(join(installed.paths.skill!, 'SKILL.md'));
  const refreshed = await refreshManagedSetup(options, { source, version: '2.0.0', beforeCommit: async () => { await rm(installed.paths.manifest); } });
  assert.equal(refreshed.status, 'blocked');
  await assert.rejects(readFile(installed.paths.manifest), { code: 'ENOENT' });
  assert.deepEqual(await readFile(installed.paths.config), config);
  assert.deepEqual(await readFile(join(installed.paths.skill!, 'SKILL.md')), skill);
});

test('simultaneous startup syncs cannot write across the setup lock or downgrade the winner', async t => {
  const { cwd, source } = await fixture(t);
  const options = { client: 'cursor', cwd };
  const installed = await setup(options, { source, version: '0.1.9' });
  await writeFile(join(source, 'SKILL.md'), 'Current skill');
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = refreshManagedSetup(options, { source, version: '0.1.10', beforeCommit: async () => { entered(); await gate; } });
  await held;
  try { assert.equal((await refreshManagedSetup(options, { source, version: '0.1.11' })).status, 'blocked'); }
  finally { release(); }
  assert.equal((await first).status, 'updated');
  assert.equal(JSON.parse(await readFile(installed.paths.manifest, 'utf8')).version, '0.1.10');
  assert.equal((await refreshManagedSetup(options, { source, version: '0.1.9' })).status, 'skipped');
  assert.equal(JSON.parse(await readFile(installed.paths.manifest, 'utf8')).version, '0.1.10');
  assert.equal((await refreshManagedSetup(options, { source, version: '0.1.11' })).status, 'updated');
});

for (const platform of ['darwin', 'win32'] as const) {
  test(`Desktop ${platform}: startup updates the managed ZIP and requires manual upload`, async t => {
    const { cwd, source, home } = await fixture(t);
    const options = { client: 'claude-desktop', cwd, home, platform, env: { APPDATA: join(home, 'AppData', 'Roaming') } };
    const installed = await setup(options, { source, version: '1.0.0' });
    await writeFile(join(source, 'SKILL.md'), 'Updated Desktop skill');
    const report = await refreshManagedSetup(options, { source, version: '2.0.0' });
    assert.equal(report.status, 'updated');
    assert.equal(report.desktopSkillUploadRequired, true);
    assert.equal(strFromU8(unzipSync(await readFile(installed.paths.skillZip!))['steercards/SKILL.md']), 'Updated Desktop skill');
  });
}

test('actual serve syncs managed skills, preserves edits and serves MCP even when refresh is blocked or absent', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const state of ['managed', 'edited', 'absent']) {
    await t.test(state, async t => {
      const { cwd, source } = await fixture(t);
      const installed = state === 'absent' ? undefined : await setup({ client: 'cursor', cwd }, { source, version: '0.0.1' });
      if (state === 'edited') await writeFile(join(installed!.paths.skill!, 'SKILL.md'), 'User private edit');
      const before = await tree(cwd);
      const env = { ...process.env };
      delete env.STEERCARDS_AGENT_KEY; delete env.STEERCARDS_MCP_URL;
      const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/cli.ts', 'serve', '--client', 'cursor', '--cwd', cwd], cwd: root, env: env as Record<string, string>, stderr: 'pipe' });
      let stderr = '';
      transport.stderr?.on('data', chunk => { stderr += chunk; });
      const client = new Client({ name: 'startup-regression', version: '1' });
      try {
        await client.connect(transport, { timeout: 10000 });
        assert.equal((await client.listTools()).tools.length, 4, 'stdout remains valid MCP frames');
        assert.ok(!stderr.includes('synthetic-startup-key') && !stderr.includes('User private edit'));
        if (state === 'managed') {
          assert.deepEqual(await readFile(join(installed!.paths.skill!, 'SKILL.md')), await readFile(join(skillRoot, 'SKILL.md')));
          assert.equal(JSON.parse(stderr.trim()).status, 'updated');
        } else {
          assert.deepEqual(await tree(cwd), before);
          if (state === 'edited') assert.equal(JSON.parse(stderr.trim()).status, 'blocked');
          else assert.equal(stderr, '');
        }
      } finally { await client.close(); }
    });
  }
});
