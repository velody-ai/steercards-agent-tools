import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
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
