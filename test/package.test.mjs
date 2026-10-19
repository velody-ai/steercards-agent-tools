import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this suite with npm run test:package.');
const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}` };
for (const name of ['STEERCARDS_AGENT_KEY', 'STEERCARDS_MCP_URL', 'NODE_OPTIONS', 'NODE_PATH']) delete env[name];

function run(command, args, options = {}) {
  const { input, ...spawnOptions } = options;
  // Node cannot spawn npm's Windows .cmd shims directly. Exercise the actual
  // shim through cmd.exe; the fixture arguments contain no shell metacharacters.
  if (process.platform === 'win32' && command.endsWith('.cmd')) {
    args = ['/d', '/s', '/c', `"${[command, ...args].map(value => `"${value}"`).join(' ')}"`];
    command = process.env.ComSpec ?? 'cmd.exe';
    spawnOptions.windowsVerbatimArguments = true;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, windowsHide: true, timeout: 30000, ...spawnOptions });
    child.stdin.end(input);
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function json(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  return JSON.parse(result.stdout);
}

test('packed npm launchers preserve project env-file semantics', { timeout: 240000 }, async t => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'steercards-package-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const consumer = join(temp, 'consumer');
  const project = join(temp, '한글 project with spaces');
  await mkdir(consumer);
  await mkdir(project);
  const packed = json(await run(process.execPath, ['--', npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', temp]));
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const tarball = `file:${join(temp, packed[0].filename)}`;
  const consumerManifest = { name: 'package-test-consumer', private: true, dependencies: { [manifest.name]: tarball } };
  // Reuse the checked-in dependency resolutions and npm-ci cache so this is a
  // fresh tarball install, without a registry lookup or source-tree symlink.
  const packages = Object.fromEntries(Object.entries(lock.packages).filter(([name, value]) => name && !value.dev));
  packages[''] = consumerManifest;
  packages[`node_modules/${manifest.name}`] = { version: manifest.version, resolved: tarball, integrity: packed[0].integrity, dependencies: manifest.dependencies, bin: manifest.bin, engines: manifest.engines };
  await writeFile(join(consumer, 'package.json'), JSON.stringify(consumerManifest));
  await writeFile(join(consumer, 'package-lock.json'), JSON.stringify({ name: consumerManifest.name, lockfileVersion: 3, packages }));
  const installed = await run(process.execPath, ['--', npmCli, 'ci', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], { cwd: consumer, timeout: 120000 });
  assert.equal(installed.status, 0, installed.stderr || `npm ci exited with signal ${installed.signal}`);

  const key = 'synthetic-package-key';
  const defaultFile = `STEERCARDS_AGENT_KEY=${key}\nSTEERCARDS_MCP_URL=https://default.example/api/mcp\n`;
  // Node must never interpret NODE_OPTIONS found in an application env file.
  const selectedFile = `STEERCARDS_AGENT_KEY=${key}\nSTEERCARDS_MCP_URL=https://selected.example/api/mcp\nNODE_OPTIONS=--require=./must-not-run.cjs\n`;
  await writeFile(join(project, '.env'), defaultFile);
  await writeFile(join(project, 'alternate.env'), selectedFile);
  const bin = join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'steercards.cmd' : 'steercards');
  const doctor = ['doctor', '--cwd', project];

  await t.test('installed bin reads default, relative, equals and absolute paths outside process cwd', async () => {
    assert.equal(json(await run(bin, doctor, { cwd: consumer })).url, 'https://default.example/api/mcp');
    for (const args of [
      ['--env-file', 'alternate.env'],
      ['--env-file=alternate.env'],
      ['--env-file', join(project, 'alternate.env')],
    ]) {
      const result = await run(bin, [...doctor, ...args], { cwd: consumer });
      const report = json(result);
      assert.equal(report.envFile, join(project, 'alternate.env'));
      assert.equal(report.url, 'https://selected.example/api/mcp');
      assert.equal(report.keySource, 'env-file');
      assert.ok(!result.stdout.includes(key));
    }
  });

  await t.test('real offline npx invokes the installed package with a relative env-file', async () => {
    // A bare quoted batch name gives npm's %~dp0 the caller directory. Resolve
    // the bundled launcher as a shell/PATH lookup normally would before cmd.
    const npx = process.platform === 'win32' ? join(dirname(process.execPath), 'npx.cmd') : 'npx';
    const report = json(await run(npx, ['--offline', '--', 'steercards', ...doctor, '--env-file', 'alternate.env'], { cwd: consumer }));
    assert.equal(report.envFile, join(project, 'alternate.env'));
    assert.equal(report.keySource, 'env-file');
  });

  await t.test('process precedence, missing files and same-name caller files use application rules', async () => {
    const args = [...doctor, '--env-file', 'alternate.env'];
    const inherited = { ...env, STEERCARDS_AGENT_KEY: 'synthetic-environment-key', STEERCARDS_MCP_URL: 'https://environment.example/api/mcp' };
    const report = json(await run(bin, args, { cwd: consumer, env: inherited }));
    assert.equal(report.keySource, 'environment');
    assert.equal(report.url, 'https://environment.example/api/mcp');
    assert.equal(json(await run(bin, [...args, '--url', 'https://flag.example/api/mcp'], { cwd: consumer, env: inherited })).url, 'https://flag.example/api/mcp');
    const missing = await run(bin, [...doctor, '--env-file', 'missing.env'], { cwd: consumer });
    assert.equal(missing.status, 1);
    assert.match(JSON.parse(missing.stderr).error, /Unable to read the selected environment file/);
    const emptyKey = await run(bin, args, { cwd: consumer, env: { ...env, STEERCARDS_AGENT_KEY: '' } });
    assert.equal(emptyKey.status, 1);
    assert.match(JSON.parse(emptyKey.stderr).error, /nonempty Agent Key/);
    await writeFile(join(consumer, 'alternate.env'), 'NODE_OPTIONS=--require=./must-not-run-either.cjs\nSTEERCARDS_AGENT_KEY=wrong-key\n');
    assert.equal(json(await run(bin, args, { cwd: consumer })).url, 'https://selected.example/api/mcp');
  });

  await t.test('generated local and pinned npx MCP commands connect from another directory', async () => {
    await mkdir(join(project, '.cursor'));
    await writeFile(join(project, '.cursor', 'mcp.json'), '{"theme":"preserved","mcpServers":{"other":{"command":"other"}}}');
    for (const local of [true, false]) {
      const report = json(await run(bin, ['setup', '--client', 'cursor', '--cwd', project, ...(local ? ['--local', '--env-file', 'alternate.env'] : ['--npx'])], { cwd: consumer }));
      assert.equal(report.status, local ? 'installed' : 'updated');
      const config = JSON.parse(await readFile(report.paths.config, 'utf8'));
      assert.equal(config.theme, 'preserved');
      assert.equal(config.mcpServers.other.command, 'other');
      const server = config.mcpServers.steercards;
      const transport = new StdioClientTransport({ ...server, cwd: consumer, env: { ...env, npm_config_offline: 'true' }, stderr: 'pipe' });
      const client = new Client({ name: 'package-regression', version: '1' });
      let stderr = '';
      transport.stderr?.on('data', chunk => { stderr += chunk; });
      try {
        await client.connect(transport, { timeout: 15000 });
        assert.equal((await client.listTools()).tools.length, 4);
        const guide = await client.callTool({ name: 'steercards_get_guide', arguments: {} });
        assert.equal(guide.isError, undefined);
        assert.match(guide.content[0].text, /Steercards/);
      } catch (error) {
        throw new Error(`${local ? 'local' : 'npx'} MCP failed: ${stderr}`, { cause: error });
      } finally { await client.close(); }
    }
    assert.equal(json(await run(bin, ['setup', '--client', 'cursor', '--cwd', project], { cwd: consumer })).status, 'unchanged');
  });

  await t.test('Windows PowerShell npm shim preserves the env-file option', { skip: process.platform !== 'win32' }, async () => {
    const report = json(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', bin.replace(/\.cmd$/, '.ps1'), ...doctor, '--env-file', 'alternate.env'], { cwd: consumer }));
    assert.equal(report.envFile, join(project, 'alternate.env'));
    assert.equal(report.keySource, 'env-file');
  });

  await t.test('one-use setup through packed bin and PowerShell npx keeps secrets off output', async () => {
    const code = `sc_install_${'C'.repeat(43)}`;
    const token = `sc_agent_${'T'.repeat(43)}`;
    let exchanges = 0, calls = 0;
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/agent-setup/exchange') {
        assert.equal(JSON.parse(body).code, code); exchanges++;
        res.end(JSON.stringify({ token, key: { id: 'd64b013e-9338-45e0-b95b-eb162df86e58' }, installationId: 'cda81bb1-80c4-43bf-99ec-362f2f3b9d97', profileIds: [] })); return;
      }
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      const rpc = JSON.parse(body);
      if (rpc.id === undefined) { res.writeHead(202); res.end(); return; }
      let result;
      if (rpc.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
      else if (rpc.method === 'tools/list') result = { tools: [{ name: 'list_workspaces', inputSchema: { type: 'object' } }] };
      else { calls++; result = { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } }; }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/api/mcp`;
    try {
      const newProject = join(temp, 'one prompt project');
      await mkdir(newProject);
      const args = ['setup', '--client', 'cursor', '--cwd', '.', '--env-file', '.env', '--url', url, '--setup-code-stdin'];
      const preview = json(await run(bin, [...args, '--dry-run'], { cwd: newProject, input: code + '\r\n' }));
      assert.equal(preview.credentials.status, 'dry-run');
      assert.equal(exchanges, 0);
      await assert.rejects(readFile(join(newProject, '.env')), { code: 'ENOENT' });
      const invalid = await run(bin, args, { cwd: newProject, input: code + 'x'.repeat(1100) });
      assert.equal(invalid.status, 1);
      assert.ok(!invalid.stderr.includes(code));
      assert.equal(exchanges, 0);
      const first = await run(bin, args, { cwd: newProject, input: code + '\r\n', env: { ...env, STEERCARDS_AGENT_KEY: 'wrong-inherited-key' } });
      const report = json(first);
      assert.equal(report.ok, true, report.error);
      assert.equal(report.credentials.status, 'saved');
      assert.equal(report.doctor.keySource, 'env-file');
      assert.ok(!first.stdout.includes(token) && !first.stderr.includes(token));
      assert.ok(!first.stdout.includes(code) && !first.stderr.includes(code));
      assert.equal(await readFile(join(newProject, '.env'), 'utf8'), `STEERCARDS_AGENT_KEY=${token}\n`);
      assert.equal(json(await run(bin, args, { cwd: newProject, input: code + '\n' })).credentials.status, 'kept');
      assert.equal(exchanges, 1);
      if (process.platform === 'win32') {
        const psProject = join(consumer, 'powershell bootstrap');
        await mkdir(psProject);
        const quote = value => `'${value.replace(/'/g, "''")}'`;
        const npx = join(dirname(process.execPath), 'npx.ps1');
        const command = `@'\r\n${code}\r\n'@ | & ${quote(npx)} ${['--offline', '--', 'steercards', ...args].map(quote).join(' ')}`;
        const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { cwd: psProject });
        assert.equal(json(result).ok, true, result.stderr);
        assert.ok(!result.stdout.includes(token));
        assert.equal(exchanges, 2);
      }
      assert.ok(calls >= 2);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });

  assert.equal(await readFile(join(project, '.env'), 'utf8'), defaultFile);
  assert.equal(await readFile(join(project, 'alternate.env'), 'utf8'), selectedFile);
});
