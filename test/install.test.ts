import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { clientConfig, installSkill, exportSkill, clients } from '../src/install.js';

async function fixture(t: { after: (cb: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'steercards-install-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(join(source, 'references'), { recursive: true });
  await writeFile(join(source, 'SKILL.md'), '---\nname: steercards\ndescription: Manage Steercards\n---\nGuide');
  await writeFile(join(source, 'references', 'work.md'), 'Work reference');
  return { root, source };
}

test('every client config pins project and mode without reading dotenv', () => {
  for (const client of clients) {
    const config = clientConfig(client, { cwd: join(tmpdir(), 'project with spaces'), local: true, mode: 'full' });
    assert.ok(config.includes('serve'));
    assert.ok(config.includes('--cwd'));
    assert.ok(config.includes('full'));
    assert.ok(!config.includes('STEERCARDS_AGENT_KEY'));
    if (!client.startsWith('codex')) {
      const server = JSON.parse(config).mcpServers.steercards;
      assert.equal(server.command, process.execPath);
      assert.equal(server.args[0], '--');
      assert.ok(server.args[1].endsWith('cli.js'));
      if (client === 'cursor') assert.equal(server.type, 'stdio');
    }
  }
  assert.throws(() => clientConfig('invalid'));
  assert.throws(() => clientConfig('codex', { url: 'https://user:secret@example.com/api/mcp' }));
});

test('npm client commands use latest with a canonical startup-sync client; local commands stay fixed', () => {
  for (const client of clients) {
    const generated = clientConfig(client);
    assert.ok(generated.includes('@steercards/agent-tools@latest'));
    assert.ok(generated.includes('--client'));
    assert.ok(generated.includes(client.startsWith('codex') ? 'codex' : client));
    assert.ok(!clientConfig(client, { local: true }).includes('--client'));
    assert.ok(!clientConfig(client, { local: true }).includes('@latest'));
  }
});

test('skill installation preserves existing content and supports idempotent reinstall', async t => {
  const { root, source } = await fixture(t);
  const options = { client: 'codex', cwd: root, source };
  const result = await installSkill(options);
  assert.equal(result.status, 'installed');
  assert.equal(await readFile(join(result.path, 'references', 'work.md'), 'utf8'), 'Work reference');
  assert.equal((await installSkill(options)).status, 'unchanged');
  await writeFile(join(result.path, 'SKILL.md'), 'User edited');
  await assert.rejects(installSkill(options), /Existing skill differs/);
  assert.equal(await readFile(join(result.path, 'SKILL.md'), 'utf8'), 'User edited');
});

test('global and client-specific installs target correct directories', async t => {
  const { root, source } = await fixture(t);
  for (const [client, dir] of [['claude-code', '.claude'], ['cursor', '.cursor'], ['codex-app', '.agents']]) {
    const result = await installSkill({ client, source, global: true, home: root });
    assert.equal(result.path, join(root, dir, 'skills', 'steercards'));
  }
  await assert.rejects(installSkill({ client: 'claude-desktop', source, cwd: root }), /skill export/);
});

test('installer refuses symbolic links within destination', { skip: process.platform === 'win32' }, async t => {
  const { root, source } = await fixture(t);
  const outside = join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(root, '.agents'));
  await assert.rejects(installSkill({ client: 'codex', source, cwd: root }), /symbolic link/);
});

test('Desktop ZIP contains complete portable skill and never overwrites a file', async t => {
  const { root, source } = await fixture(t);
  const path = join(root, 'steercards.zip');
  await exportSkill(path, source);
  const files = unzipSync(await readFile(path));
  assert.ok(strFromU8(files['steercards/SKILL.md']).includes('name: steercards'));
  assert.equal(strFromU8(files['steercards/references/work.md']), 'Work reference');
  await assert.rejects(exportSkill(path, source), /EEXIST/);
});
