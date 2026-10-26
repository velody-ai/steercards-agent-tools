import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
const root = fileURLToPath(new URL('../', import.meta.url));
function cli(args: string[], input?: string) {
  const env = { ...process.env };
  delete env.STEERCARDS_AGENT_KEY;
  delete env.STEERCARDS_MCP_URL;
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root, env, input, encoding: 'utf8', timeout: 10000 });
}

test('CLI help, version and config do not require credentials', async () => {
  const version = cli(['--version']);
  assert.equal(version.status, 0);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(version.stdout.trim(), pkg.version);
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--env-file/);
  const config = cli(['config', 'claude-desktop', '--local']);
  assert.equal(config.status, 0);
  assert.equal(JSON.parse(config.stdout).mcpServers.steercards.command, process.execPath);
});

test('CLI rejects an unsupported Node version before setup can write files', async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'steercards-old-node-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const preload = `data:text/javascript,${encodeURIComponent("Object.defineProperty(process.versions, 'node', { value: '20.20.0' });")}`;
  const result = spawnSync(process.execPath, ['--import', preload, '--import', 'tsx', 'src/cli.ts', 'setup', '--client', 'cursor', '--cwd', cwd], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stderr).error, /require Node.js 22 or newer/);
  assert.equal(result.stdout, '');
  assert.deepEqual(await readdir(cwd), []);
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

test('CLI rejects invalid exploration arguments before connecting', () => {
  for (const args of [
    ['explore', '--workspace', '1'],
    ['explore', 'ls /'],
    ...['0', '-1', '1.2', '1e2', '9007199254740992', 'abc'].map(workspace => ['explore', '--workspace', workspace, 'ls /']),
    ...['0', '16001', '1.5', 'NaN'].map(maxChars => ['explore', '--workspace', '1', '--max-chars', maxChars, 'ls /']),
    ...['0', '-1', '1.5', '9007199254740992', 'abc'].map(board => ['explore', '--workspace', '1', '--board', board, 'ls /']),
    ...['', ' ', '0', '9007199254740992'].map(status => ['explore', '--workspace', '1', '--status', status, 'ls /']),
    ['explore', '--workspace', '1', ...Array.from({ length: 21 }, () => ['--status', 'In progress']).flat(), 'ls /'],
    ['explore', '--workspace', '1', '--archived', 'true', 'ls /'],
    ['explore', '--workspace', '1', '--cursor', '', 'ls /'],
    ['explore', '--workspace', '1', 'ls', '/'],
    ['explore', '--workspace', '1', '   '],
    ['explore', '--workspace', '1', '--json', '{}', 'ls /'],
    ['explore', '--workspace', '1', '--stdin', 'ls /'],
    ['explore', '--workspace', '1', '--mode', 'full', 'ls /'],
    ['call', 'explore_cards', '--workspace', '1'],
    ['doctor', '--cursor', 'opaque'],
    ['doctor', '--include-relations'],
    ['tools', '--status', 'In progress'],
    ['call', 'explore_cards', '--board', '1'],
    ['setup', '--client', 'codex', '--archived', 'all'],
    ['setup', '--client', 'codex', '--max-chars', '100'],
  ]) {
    const result = cli(args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).ok, false);
    assert.doesNotMatch(result.stderr, /Agent Key is required/);
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
  assert.equal(report.paths.skills.steercards, report.paths.skill);
  assert.match(await readFile(join(report.paths.skills['steercards-workflow'], 'SKILL.md'), 'utf8'), /name: steercards-workflow/);
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

test('skill install and export select onboarding explicitly and reject unknown or misplaced selection', async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'steercards-workflow-cli-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const installed = cli(['skill', 'install', '--client', 'cursor', '--skill', 'steercards-workflow', '--cwd', cwd]);
  assert.equal(installed.status, 0, installed.stderr);
  const path = JSON.parse(installed.stdout).path;
  assert.equal(path, join(cwd, '.cursor', 'skills', 'steercards-workflow'));
  assert.match(await readFile(join(path, 'SKILL.md'), 'utf8'), /name: steercards-workflow/);
  const exported = cli(['skill', 'export', '--skill', 'steercards-workflow', '--output', 'workflow.zip', '--cwd', cwd]);
  assert.equal(exported.status, 0, exported.stderr);
  const entries = unzipSync(await readFile(JSON.parse(exported.stdout).path));
  assert.match(strFromU8(entries['steercards-workflow/SKILL.md']), /name: steercards-workflow/);
  assert.equal(entries['steercards/SKILL.md'], undefined);
  for (const args of [
    ['skill', 'install', '--client', 'codex', '--skill', '../escape'],
    ['skill', 'export', '--output', 'invalid.zip', '--skill', 'unknown'],
    ['setup', '--client', 'cursor', '--skill', 'steercards-workflow'],
    ['serve', '--skill', 'steercards-workflow'],
  ]) {
    const result = cli([...args, '--cwd', cwd]);
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stderr).error, /Unknown skill|--skill is only supported/);
  }
  assert.ok(!(await readdir(cwd)).includes('invalid.zip'));
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

test('code setup keeps final JSON on stdout and safe progress on stderr for pending and failures', async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'steercards-confirm-cli-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const code = `sc_install_${'C'.repeat(43)}`;
  const token = `sc_agent_${'T'.repeat(43)}`;
  await writeFile(join(cwd, '.env'), `STEERCARDS_AGENT_KEY=${token}\n`);
  const args = ['setup', '--client', 'codex', '--cwd', cwd, '--setup-code-stdin', '--confirm-existing-key'];
  const pending = cli(args, code + '\n');
  assert.equal(pending.status, 0, pending.stderr);
  assert.equal(JSON.parse(pending.stdout).status, 'confirmation-required');
  assert.equal(JSON.parse(pending.stdout).ok, false);
  assert.equal(JSON.parse(pending.stdout).error, undefined);
  assert.deepEqual(await readdir(cwd), ['.env']);
  const events = pending.stderr.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => [event.stage, event.status]), [['preflight', 'started'], ['preflight', 'completed']]);
  assert.ok(events.every(event => event.type === 'steercards-setup-progress' && typeof event.elapsedMs === 'number'));
  const preview = cli([...args, '--keep-agent-key', '--dry-run'], code + '\n');
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).status, 'dry-run');
  await rm(join(cwd, '.env'));
  const missing = cli([...args, '--keep-agent-key'], code + '\n');
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).status, 'failed');
  assert.equal(JSON.parse(missing.stderr.trim().split('\n').at(-1)!).status, 'failed');
  for (const result of [pending, preview, missing]) {
    assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token));
    assert.ok(!result.stdout.includes(code) && !result.stderr.includes(code));
  }
  const conflicting = cli([...args, '--keep-agent-key', '--replace-agent-key'], code + '\n');
  assert.equal(conflicting.status, 1);
  assert.match(conflicting.stderr, /Choose only one/);
  for (const flag of ['--confirm-existing-key', '--keep-agent-key']) {
    assert.equal(cli(['setup', '--client', 'cursor', flag]).status, 1);
    assert.equal(cli(['doctor', flag]).status, 1);
  }
});
