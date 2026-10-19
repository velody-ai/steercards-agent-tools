import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
function cli(args: string[], input?: string) {
  const env = { ...process.env };
  delete env.STEERCARDS_AGENT_KEY;
  delete env.STEERCARDS_MCP_URL;
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root, env, input, encoding: 'utf8', timeout: 10000 });
}

test('CLI help, version and config do not require credentials', () => {
  const version = cli(['--version']);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), '0.1.0');
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--env-file/);
  const config = cli(['config', 'claude-desktop', '--local']);
  assert.equal(config.status, 0);
  assert.equal(JSON.parse(config.stdout).mcpServers.steercards.command, process.execPath);
});

test('CLI dotenv doctor never outputs credential or unrelated environment values', async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'steercards-cli-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, '.env'), 'STEERCARDS_AGENT_KEY=test-secret-cli-key\nUNRELATED_SECRET=private-value\n');
  const result = cli(['doctor', '--cwd', cwd]);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).keySource, 'env-file');
  assert.equal(JSON.parse(result.stdout).connected, false);
  assert.ok(!result.stdout.includes('test-secret-cli-key'));
  assert.ok(!result.stdout.includes('private-value'));
});

test('CLI rejects ambiguous and invalid call input before connecting', () => {
  for (const args of [
    ['call', 'create_card', '--json', '{}', '--stdin'],
    ['call', 'create_card', '--json', '[]'],
    ['call', 'create_card', '--json', 'null'],
    ['call', 'create_card', '--json', '{broken'],
    ['call', 'create_card', '--stdin'],
    ['describe'],
    ['serve', '--mode', 'invalid'],
  ]) {
    const result = cli(args, '[]');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).ok, false);
  }
});

test('setup installs MCP and skill with one command, preserves dotenv, and reruns unchanged', async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'steercards-setup-cli-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const dotenv = 'STEERCARDS_AGENT_KEY=fixture-setup-must-not-read-or-print\n';
  await writeFile(join(cwd, '.env'), dotenv);
  const installed = cli(['setup', '--client', 'codex-app', '--local', '--cwd', cwd]);
  assert.equal(installed.status, 0, installed.stderr);
  const report = JSON.parse(installed.stdout);
  assert.equal(report.status, 'installed');
  assert.ok(report.paths.config.endsWith('config.toml'));
  assert.ok((await readFile(report.paths.config, 'utf8')).includes('mcp_servers.steercards'));
  assert.ok((await readFile(join(report.paths.skill, 'SKILL.md'), 'utf8')).includes('name: steercards'));
  assert.equal(await readFile(join(cwd, '.env'), 'utf8'), dotenv);
  assert.ok(!installed.stdout.includes('fixture-setup-must-not-read-or-print'));
  const again = cli(['setup', '--client', 'codex-cli', '--cwd', cwd]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).status, 'unchanged');
  const switched = cli(['setup', '--client', 'codex', '--npx', '--cwd', cwd]);
  assert.equal(switched.status, 0, switched.stderr);
  assert.equal(JSON.parse(switched.stdout).status, 'updated');
  assert.match(await readFile(report.paths.config, 'utf8'), /command = \"npx\"/);
});

test('setup preview and noninteractive selection failures never write files', async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'steercards-setup-preview-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const args of [
    ['setup', '--client', 'cursor', '--dry-run', '--cwd', cwd],
    ['setup', '--cwd', cwd],
    ['setup', '--client', 'codex', '--global', '--cwd', cwd],
    ['setup', '--client', 'unknown', '--cwd', cwd],
    ['setup', '--client', 'codex', '--local', '--npx', '--cwd', cwd],
    ['setup', '--client', 'codex', '--output', 'unexpected.zip', '--cwd', cwd],
  ]) {
    const result = cli(args);
    assert.equal(result.status, args.includes('--dry-run') ? 0 : 1, result.stderr);
    assert.deepEqual(await readdir(cwd), []);
  }
});
