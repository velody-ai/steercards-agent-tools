import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
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

  assert.equal((await run(bin, ['--version'], { cwd: consumer })).stdout.trim(), manifest.version);

  await t.test('packed setup accepts exact manual merges and preserves distinct local edits', async () => {
    const upgradeProject = join(temp, 'manual merge project'), oldSource = join(temp, 'previous skill');
    await mkdir(upgradeProject); await mkdir(join(oldSource, 'references'), { recursive: true });
    for (const name of ['SKILL.md', 'references/claims-runs.md', 'references/collaboration.md', 'references/cards.md']) await writeFile(join(oldSource, name), `Previous ${name}`);
    const installedRoot = join(consumer, 'node_modules', '@steercards', 'agent-tools');
    const { setup: packedSetup } = await import(pathToFileURL(join(installedRoot, 'dist', 'setup.js')).href);
    const installed = await packedSetup({ client: 'cursor', cwd: upgradeProject }, { source: oldSource, version: '0.2.2' });
    const legacy = JSON.parse(await readFile(installed.paths.manifest, 'utf8'));
    const { skills: _paths, ...legacyPaths } = legacy.paths;
    const { skills, ...legacyFields } = legacy;
    await writeFile(installed.paths.manifest, JSON.stringify({ ...legacyFields, schemaVersion: 1, paths: legacyPaths, skill: skills.steercards }));
    const envPath = join(upgradeProject, '.env'), envBytes = 'STEERCARDS_AGENT_KEY=manual-merge-fixture-key\r\nOTHER=preserved\r\n';
    await writeFile(envPath, envBytes);
    await writeFile(join(installed.paths.skill, 'user-notes.md'), 'Preserve custom notes');
    const config = await readFile(installed.paths.config), previousManifest = await readFile(installed.paths.manifest);
    for (const name of ['SKILL.md', 'references/claims-runs.md', 'references/collaboration.md']) await writeFile(join(installed.paths.skill, name), await readFile(join(installedRoot, 'skills', 'steercards', name)));
    assert.deepEqual(await readFile(installed.paths.manifest), previousManifest);
    const setupArgs = ['setup', '--client', 'cursor', '--cwd', upgradeProject];
    const report = json(await run(bin, setupArgs, { cwd: consumer }));
    assert.equal(report.status, 'updated');
    assert.equal(report.paths.skills.steercards, report.paths.skill);
    assert.match(await readFile(join(report.paths.skills['steercards-workflow'], 'SKILL.md'), 'utf8'), /name: steercards-workflow/);
    assert.equal(report.version, manifest.version);
    assert.equal(JSON.parse(await readFile(installed.paths.manifest, 'utf8')).version, manifest.version);
    assert.deepEqual(await readFile(join(installed.paths.skill, 'references', 'cards.md')), await readFile(join(installedRoot, 'skills', 'steercards', 'references', 'cards.md')));
    assert.equal(await readFile(join(installed.paths.skill, 'user-notes.md'), 'utf8'), 'Preserve custom notes');
    assert.deepEqual(await readFile(installed.paths.config), config);
    assert.equal(await readFile(envPath, 'utf8'), envBytes);
    assert.equal(json(await run(bin, setupArgs, { cwd: consumer })).status, 'unchanged');
    await writeFile(join(installed.paths.skill, 'SKILL.md'), 'Unique user content');
    const protectedPaths = [installed.paths.config, installed.paths.manifest, envPath, join(installed.paths.skill, 'SKILL.md'), join(installed.paths.skill, 'references', 'cards.md')];
    const snapshots = await Promise.all(protectedPaths.map(path => readFile(path)));
    const blocked = await run(bin, setupArgs, { cwd: consumer });
    assert.equal(blocked.status, 1);
    assert.match(JSON.parse(blocked.stderr).error, /Managed skill file/);
    assert.deepEqual(await Promise.all(protectedPaths.map(path => readFile(path))), snapshots);
    assert.ok(!`${blocked.stdout}${blocked.stderr}`.includes('manual-merge-fixture-key'));
    assert.ok(!`${blocked.stdout}${blocked.stderr}`.includes('Unique user content'));
  });

  await t.test('packed workflow selection installs independently and exports its own ZIP', async () => {
    const skillProject = join(temp, 'workflow consumer');
    await mkdir(skillProject);
    const report = json(await run(bin, ['skill', 'install', '--client', 'codex', '--skill', 'steercards-workflow', '--cwd', skillProject], { cwd: consumer }));
    assert.equal(report.path, join(skillProject, '.agents', 'skills', 'steercards-workflow'));
    assert.match(await readFile(join(report.path, 'SKILL.md'), 'utf8'), /name: steercards-workflow/);
    for (const skill of ['steercards', 'steercards-workflow']) {
      const archive = join(temp, `${skill}.zip`);
      json(await run(bin, ['skill', 'export', '--skill', skill, '--output', archive], { cwd: consumer }));
      const files = unzipSync(await readFile(archive));
      assert.match(strFromU8(files[`${skill}/SKILL.md`]), new RegExp(`name: ${skill}`));
      assert.ok(Object.keys(files).every(path => path.startsWith(`${skill}/`)));
    }
  });

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

  await t.test('packed exploration CLI and compact/full MCP preserve bounded pages and source metadata', async () => {
    const command = 'rg -n expired /projects/7/boards/19/cards';
    const sources = [{ cardId: 42, path: '/projects/7/boards/19/cards/SC-42/card.md', cardKey: 'SC-42', url: 'https://steercards.example/hello/SC-42', archivedAt: null,
      statuses: [{ propertyId: 1, propertyName: 'Status', optionId: 456, name: 'In progress', section: 'in_progress' }],
      relations: { parent: null, children: [], childCount: 0, childrenComplete: true } }];
    const passage = `${sources[0].path}:12:session expired 🔑\n`;
    const matches = [{ cardId: 42, snippets: [{ path: sources[0].path, kind: 'card', startLine: 12, endLine: 12, matchedLines: [12], outputStart: 0, outputEnd: passage.length, partial: false }] }];
    const first = { ok: true, data: { workspaceId: 123, output: '', complete: false, nextCursor: 'opaque-cursor.2', stopReason: 'scan_limit', exitCode: null, sources: [], matches: [] } };
    const second = { ok: true, data: { workspaceId: 123, output: passage, complete: true, nextCursor: null, stopReason: null, exitCode: 0, sources, matches } };
    const noMatch = { ok: true, data: { workspaceId: 123, output: '', complete: true, nextCursor: null, stopReason: null, exitCode: 1, sources: [] } };
    const failure = { ok: false, error: { code: 'UNSUPPORTED_COMMAND', message: 'Unsupported command.', status: 400 } };
    const calls = [];
    const envelope = product => ({ content: [{ type: 'text', text: JSON.stringify(product) }], structuredContent: product, isError: false, _meta: { fixture: 'preserved' } });
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      let body = '';
      for await (const chunk of req) body += chunk;
      const rpc = JSON.parse(body);
      if (rpc.id === undefined) { res.writeHead(202); res.end(); return; }
      let result;
      if (rpc.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'exploration-fixture', version: '1' } };
      else if (rpc.method === 'tools/list') result = { tools: [{ name: 'explore_cards', description: 'Read-only directory card content explorer.', inputSchema: { type: 'object', properties: { workspaceId: { type: 'integer' }, command: { type: 'string' }, cursor: { type: 'string' }, maxChars: { type: 'integer' }, boardId: { type: 'integer' }, status: { anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'integer' }] } }] }, archived: { type: 'string', enum: ['active', 'archived', 'all'] }, includeRelations: { type: 'boolean' } }, required: ['workspaceId', 'command'] } }] };
      else {
        assert.equal(rpc.method, 'tools/call');
        assert.equal(rpc.params.name, 'explore_cards');
        calls.push(rpc.params.arguments);
        result = envelope(rpc.params.arguments.command === 'unsupported' ? failure
          : rpc.params.arguments.command === 'rg absent /projects' ? noMatch
          : rpc.params.arguments.cursor ? second : first);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/api/mcp`;
    const options = ['--cwd', project, '--url', url];
    try {
      assert.deepEqual(json(await run(bin, ['explore', '--workspace', '123', command, '--max-chars', '2000', ...options], { cwd: consumer })), envelope(first));
      assert.deepEqual(calls.at(-1), { workspaceId: 123, command, maxChars: 2000 });
      assert.deepEqual(json(await run(bin, ['explore', '--workspace=123', command, '--cursor', first.data.nextCursor, '--max-chars=2000', ...options], { cwd: consumer })), envelope(second));
      assert.deepEqual(calls.at(-1), { workspaceId: 123, command, cursor: first.data.nextCursor, maxChars: 2000 });
      const filters = ['--board', '19', '--status', 'In progress', '--status', '456', '--archived', 'active', '--include-relations'];
      const filterArgs = { boardId: 19, status: ['In progress', 456], archived: 'active', includeRelations: true };
      assert.deepEqual(json(await run(bin, ['explore', '--workspace', '123', command, '--max-chars', '2000', ...filters, ...options], { cwd: consumer })), envelope(first));
      assert.deepEqual(calls.at(-1), { workspaceId: 123, command, maxChars: 2000, ...filterArgs });
      assert.deepEqual(json(await run(bin, ['explore', '--workspace', '123', command, '--max-chars', '2000', '--cursor', first.data.nextCursor, ...filters, ...options], { cwd: consumer })), envelope(second));
      assert.deepEqual(calls.at(-1), { workspaceId: 123, command, maxChars: 2000, cursor: first.data.nextCursor, ...filterArgs });
      for (const [value, expected] of [['456', 456], ['In progress', 'In progress']]) {
        json(await run(bin, ['explore', '--workspace', '123', command, '--status', value, '--archived', 'archived', ...options], { cwd: consumer }));
        assert.deepEqual(calls.at(-1), { workspaceId: 123, command, status: expected, archived: 'archived' });
      }
      assert.deepEqual(json(await run(bin, ['explore', '--workspace', '123', 'rg absent /projects', ...options], { cwd: consumer })), envelope(noMatch));
      assert.deepEqual(calls.at(-1), { workspaceId: 123, command: 'rg absent /projects' });
      const failed = await run(bin, ['explore', '--workspace', '123', 'unsupported', ...options], { cwd: consumer });
      assert.equal(failed.status, 1);
      assert.deepEqual(JSON.parse(failed.stdout), envelope(failure));
      assert.equal(calls.length, 8, 'each CLI request calls upstream once, without automatic listings or body reads');
      for (const mode of ['compact', 'full']) {
        const transport = new StdioClientTransport({ command: process.execPath, args: ['--', join(consumer, 'node_modules', '@steercards', 'agent-tools', 'dist', 'cli.js'), 'serve', '--mode', mode, ...options], cwd: consumer, env, stderr: 'pipe' });
        const client = new Client({ name: 'exploration-package', version: '1' });
        try {
          await client.connect(transport);
          assert.match(client.getInstructions(), /explore_cards/);
          const tools = (await client.listTools()).tools;
          assert.equal(tools.length, mode === 'compact' ? 4 : 1);
          if (mode === 'compact') assert.match(tools.find(tool => tool.name === 'steercards_search_tools').description, /explore_cards/);
          const args = { workspaceId: 123, command, cursor: first.data.nextCursor, maxChars: 2000, ...filterArgs };
          const result = await client.callTool(mode === 'compact'
            ? { name: 'steercards_call_tool', arguments: { name: 'explore_cards', arguments: args } }
            : { name: 'explore_cards', arguments: args });
          assert.deepEqual(result, envelope(second));
          assert.deepEqual(calls.at(-1), args);
          const resources = await client.listResources();
          assert.ok(resources.resources.some(resource => resource.uri === 'steercards://guide/exploration'));
          const resource = await client.readResource({ uri: 'steercards://guide/exploration' });
          assert.match(resource.contents[0].text, /nextCursor/);
          if (mode === 'compact') {
            const guide = await client.callTool({ name: 'steercards_get_guide', arguments: { topic: 'exploration' } });
            assert.match(guide.structuredContent.guide, /comments\.md/);
          }
        } finally { await client.close(); }
      }
      assert.equal(calls.length, 10);
      const zip = join(temp, 'exploration-skill.zip');
      json(await run(bin, ['skill', 'export', '--output', zip], { cwd: consumer }));
      const files = unzipSync(await readFile(zip));
      assert.match(strFromU8(files['steercards/references/exploration.md']), /nextCursor/);
      assert.match(strFromU8(files['steercards/SKILL.md']), /references\/exploration\.md/);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

  await t.test('packed bulk archive preserves per-card fences, partial failures and uncertain outcomes', async () => {
    const profile = '11111111-1111-4111-8111-111111111111';
    const fence = { claimId: '22222222-2222-4222-8222-222222222222', generation: 2, runId: '33333333-3333-4333-8333-333333333333' };
    const otherFence = { claimId: '44444444-4444-4444-8444-444444444444', generation: 7, runId: '55555555-5555-4555-8555-555555555555' };
    const args = { workspaceId: 123, projectId: 7, boardId: 19, agentProfileId: profile, actorName: 'bulk-fixture', cards: [
      { cardId: 42, claimFence: fence }, { card: 'WEB-43' }, { cardId: 44, claimFence: otherFence }, { card: 42, claimFence: fence },
    ] };
    const partial = { ok: true, data: { results: [
      { cardId: 42, status: 'archived', archivedAt: 1793059000000 },
      { cardId: 43, card: 'WEB-43', status: 'unchanged', archivedAt: 1793058000000 },
      { cardId: 44, status: 'failed', error: { code: 'CARD_CLAIM_LOST', message: 'The card claim changed.', status: 409, details: { cardId: 44 } } },
    ], summary: { requested: 3, archived: 1, unchanged: 1, failed: 1 } } };
    const rejected = { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'The bulk request is invalid.', status: 400 } };
    const envelope = product => ({ content: [{ type: 'text', text: JSON.stringify(product) }], structuredContent: product, isError: !product.ok, _meta: { upstream: 'bulk-archive' } });
    const tool = { name: 'archive_cards', description: 'Archive 1–100 explicit cards on one board; results may partially fail.', inputSchema: { type: 'object', properties: {
      projectId: { type: 'integer' }, boardId: { type: 'integer' }, workspaceId: { type: 'integer' }, agentProfileId: { type: 'string', format: 'uuid' }, actorName: { type: 'string' },
      cards: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { cardId: { type: 'integer' }, card: { anyOf: [{ type: 'string' }, { type: 'integer' }] }, claimFence: { type: 'object', properties: { claimId: { type: 'string' }, generation: { type: 'integer' }, runId: { type: 'string' } }, required: ['claimId', 'generation', 'runId'] } }, oneOf: [{ required: ['cardId'] }, { required: ['card'] }], additionalProperties: false } },
    }, required: ['boardId', 'cards'], additionalProperties: false }, outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: true }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } };
    const calls = [];
    let responseMode = 'partial';
    const upstream = createServer(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      let body = '';
      for await (const chunk of req) body += chunk;
      const rpc = JSON.parse(body);
      if (rpc.id === undefined) { res.writeHead(202); res.end(); return; }
      let result;
      if (rpc.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'bulk-fixture', version: '1' } };
      else if (rpc.method === 'tools/list') result = { tools: [tool] };
      else {
        assert.equal(rpc.method, 'tools/call');
        assert.equal(rpc.params.name, 'archive_cards');
        calls.push(rpc.params.arguments);
        // A write may have committed before either transport failure. Count the
        // request before dropping its response; the wrapper must never replay it.
        if (responseMode === 'lost') { req.socket.destroy(); return; }
        if (responseMode === 'http-error') { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'AGENT_AUDIT_UNAVAILABLE' } })); return; }
        result = envelope(responseMode === 'rejected' ? rejected : partial);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const url = `http://127.0.0.1:${upstream.address().port}/api/mcp`;
    const options = ['--cwd', project, '--url', url];
    const installedRoot = join(consumer, 'node_modules', '@steercards', 'agent-tools');
    try {
      assert.equal(json(await run(bin, ['tools', 'archive_cards', ...options], { cwd: consumer }))[0].name, tool.name);
      assert.deepEqual(json(await run(bin, ['describe', 'archive_cards', ...options], { cwd: consumer })), tool);
      const file = join(temp, 'bulk arguments.json');
      await writeFile(file, JSON.stringify(args));
      for (const [inputOptions, input] of [[['--json', JSON.stringify(args)]], [['--file', file]], [['--stdin'], JSON.stringify(args)]]) {
        const before = calls.length;
        // CMD quoting is not the JSON-input contract under test. Exercise the
        // installed JS entry for --json on Windows, and real shims for file/stdin.
        const direct = process.platform === 'win32' && inputOptions[0] === '--json';
        const prefix = direct ? ['--', join(installedRoot, 'dist', 'cli.js')] : [];
        assert.deepEqual(json(await run(direct ? process.execPath : bin, [...prefix, 'call', 'archive_cards', ...inputOptions, ...options], { cwd: consumer, input })), envelope(partial));
        assert.deepEqual(calls.at(-1), args, 'CLI must preserve item order, duplicates, identity and each fence');
        assert.equal(calls.length, before + 1);
      }
      responseMode = 'rejected';
      const invalid = { ...args, cards: Array.from({ length: 101 }, () => ({ cardId: 42 })) };
      const denied = await run(bin, ['call', 'archive_cards', '--stdin', ...options], { cwd: consumer, input: JSON.stringify(invalid) });
      assert.equal(denied.status, 1);
      assert.deepEqual(JSON.parse(denied.stdout), envelope(rejected));
      assert.deepEqual(calls.at(-1), invalid, 'server remains authoritative for validation');
      for (responseMode of ['lost', 'http-error']) {
        const before = calls.length;
        const uncertain = await run(bin, ['call', 'archive_cards', '--stdin', ...options], { cwd: consumer, input: JSON.stringify(args) });
        assert.equal(uncertain.status, 1);
        assert.equal(uncertain.stdout, '');
        assert.equal(JSON.parse(uncertain.stderr).ok, false);
        assert.ok(!uncertain.stderr.includes(key));
        assert.equal(calls.length, before + 1, 'an uncertain CLI mutation is sent once');
      }

      const { Runtime, loadConfig } = await import(pathToFileURL(join(installedRoot, 'dist', 'index.js')).href);
      const runtime = new Runtime(await loadConfig({ cwd: project, url, env }));
      try {
        assert.deepEqual(await runtime.describeTool('archive_cards'), tool);
        responseMode = 'partial';
        assert.deepEqual(await runtime.callTool('archive_cards', args), envelope(partial));
        assert.deepEqual(calls.at(-1), args);
        responseMode = 'lost';
        const before = calls.length;
        await assert.rejects(runtime.callTool('archive_cards', args));
        assert.equal(calls.length, before + 1, 'an uncertain JavaScript SDK mutation is sent once');
      } finally { await runtime.close(); }

      for (const mode of ['compact', 'full']) {
        const transport = new StdioClientTransport({ command: process.execPath, args: ['--', join(installedRoot, 'dist', 'cli.js'), 'serve', '--mode', mode, ...options], cwd: consumer, env, stderr: 'pipe' });
        const client = new Client({ name: 'bulk-archive-package', version: '1' });
        const request = mode === 'compact' ? { name: 'steercards_call_tool', arguments: { name: tool.name, arguments: args } } : { name: tool.name, arguments: args };
        try {
          await client.connect(transport);
          const tools = (await client.listTools()).tools;
          assert.equal(tools.length, mode === 'compact' ? 4 : 1);
          if (mode === 'full') assert.deepEqual(tools[0], tool);
          else {
            const found = await client.callTool({ name: 'steercards_search_tools', arguments: { query: 'archive_cards' } });
            assert.equal(found.structuredContent.tools[0].name, tool.name);
            const described = await client.callTool({ name: 'steercards_describe_tool', arguments: { name: tool.name } });
            assert.deepEqual(described.structuredContent.tool, tool);
          }
          for (responseMode of ['partial', 'rejected']) {
            const before = calls.length;
            assert.deepEqual(await client.callTool(request), envelope(responseMode === 'partial' ? partial : rejected));
            assert.deepEqual(calls.at(-1), args);
            assert.equal(calls.length, before + 1);
          }
          responseMode = 'lost';
          const before = calls.length;
          await assert.rejects(client.callTool(request));
          assert.equal(calls.length, before + 1, `an uncertain ${mode} mutation is sent once`);
          const resource = await client.readResource({ uri: 'steercards://guide/cards' });
          assert.equal(resource.contents[0].text, await readFile(join(root, 'skills/steercards/references/cards.md'), 'utf8'));
          assert.match(resource.contents[0].text, /summary.*requested/);
          if (mode === 'compact') {
            const guide = await client.callTool({ name: 'steercards_get_guide', arguments: { topic: 'cards' } });
            assert.equal(guide.structuredContent.guide, resource.contents[0].text);
          }
        } finally { await client.close(); }
      }
      const zip = join(temp, 'bulk-archive-skill.zip');
      json(await run(bin, ['skill', 'export', '--output', zip], { cwd: consumer }));
      const files = unzipSync(await readFile(zip));
      assert.equal(strFromU8(files['steercards/references/cards.md']), await readFile(join(root, 'skills/steercards/references/cards.md'), 'utf8'));
      assert.match(strFromU8(files['steercards/SKILL.md']), /archive_cards/);
    } finally {
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
    }
  });

  await t.test('generated local and latest npx MCP commands connect and sync a previous managed skill', async () => {
    // The candidate is not published. Resolve @latest against its exact packed
    // bytes through a local registry, without fetching the public release.
    let metadataReads = 0;
    const registry = createServer(async (req, res) => {
      if (decodeURIComponent(req.url).toLowerCase() === '/@steercards/agent-tools') {
        metadataReads++;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ name: manifest.name, 'dist-tags': { latest: manifest.version }, versions: { [manifest.version]: { ...manifest, dist: { tarball: `${registryUrl}/candidate.tgz`, integrity: packed[0].integrity, shasum: packed[0].shasum } } } }));
      } else if (req.url === '/candidate.tgz') res.end(await readFile(join(temp, packed[0].filename)));
      else { res.writeHead(404); res.end(); }
    });
    registry.listen(0, '127.0.0.1'); await once(registry, 'listening');
    const registryUrl = `http://127.0.0.1:${registry.address().port}`;
    // Record the matching registry origin for the already installed, identical
    // tarball. npm's tag resolution can then reuse this locked local dependency.
    for (const path of [join(consumer, 'package-lock.json'), join(consumer, 'node_modules', '.package-lock.json')]) {
      const installedLock = JSON.parse(await readFile(path, 'utf8'));
      installedLock.packages[`node_modules/${manifest.name}`].resolved = `${registryUrl}/candidate.tgz`;
      await writeFile(path, JSON.stringify(installedLock));
    }
    await mkdir(join(project, '.cursor'));
    await writeFile(join(project, '.cursor', 'mcp.json'), '{"theme":"preserved","mcpServers":{"other":{"command":"other"}}}');
    try {
    for (const local of [true, false]) {
      const report = json(await run(bin, ['setup', '--client', 'cursor', '--cwd', project, ...(local ? ['--local', '--env-file', 'alternate.env'] : ['--npx'])], { cwd: consumer }));
      assert.equal(report.status, local ? 'installed' : 'updated');
      const config = JSON.parse(await readFile(report.paths.config, 'utf8'));
      assert.equal(config.theme, 'preserved');
      assert.equal(config.mcpServers.other.command, 'other');
      const server = config.mcpServers.steercards;
      assert.match(await readFile(join(project, '.cursor', 'skills', 'steercards', 'references', 'exploration.md'), 'utf8'), /nextCursor/);
      if (!local) {
        assert.ok(server.args.includes(`${manifest.name}@latest`));
        assert.equal(server.args[server.args.indexOf('--client') + 1], 'cursor');
        const previousSkill = 'Previous setup-managed skill';
        const managed = JSON.parse(await readFile(report.paths.manifest, 'utf8'));
        managed.version = '0.0.1';
        managed.skills.steercards.files['SKILL.md'] = createHash('sha256').update(previousSkill).digest('hex');
        managed.skills['steercards-workflow'].files['SKILL.md'] = createHash('sha256').update('Previous workflow skill').digest('hex');
        await writeFile(join(report.paths.skill, 'SKILL.md'), previousSkill);
        await writeFile(join(report.paths.skills['steercards-workflow'], 'SKILL.md'), 'Previous workflow skill');
        await writeFile(report.paths.manifest, JSON.stringify(managed));
      }
      const transport = new StdioClientTransport({ ...server, cwd: consumer, env: { ...env, npm_config_offline: 'false', npm_config_registry: registryUrl, npm_config_fetch_retries: '0' }, stderr: 'pipe' });
      const client = new Client({ name: 'package-regression', version: '1' });
      let stderr = '';
      transport.stderr?.on('data', chunk => { stderr += chunk; });
      try {
        await client.connect(transport, { timeout: 15000 });
        assert.deepEqual(client.getServerVersion(), { name: manifest.name, version: manifest.version });
        assert.ok(client.getInstructions()?.includes('set_agent_status'));
        const tools = (await client.listTools()).tools;
        assert.equal(tools.length, 4);
        assert.ok(tools.find(tool => tool.name === 'steercards_call_tool')?.description?.includes('clear_agent_status'), 'packed runtime must expose the work flow without an installed Skill');
        const installedSkill = await readFile(join(project, '.cursor', 'skills', 'steercards', 'SKILL.md'), 'utf8');
        assert.ok(installedSkill.includes('clear_agent_status'), 'setup must install the new default work flow');
        assert.match(await readFile(join(report.paths.skills['steercards-workflow'], 'SKILL.md'), 'utf8'), /name: steercards-workflow/);
        if (!local) {
          assert.ok(metadataReads > 0, 'the actual generated @latest command must resolve the registry tag');
          assert.equal(JSON.parse(await readFile(report.paths.manifest, 'utf8')).version, manifest.version);
          assert.ok(stderr.includes('"status":"updated"'), 'packed serve must sync the previous managed skill before speaking MCP');
        }
        const guide = await client.callTool({ name: 'steercards_get_guide', arguments: {} });
        assert.equal(guide.isError, undefined);
        assert.match(guide.content[0].text, /Steercards/);
        assert.ok(guide.content[0].text.includes('clear_agent_status'));
      } catch (error) {
        throw new Error(`${local ? 'local' : 'npx'} MCP failed: ${stderr}`, { cause: error });
      } finally { await client.close(); }
    }
    assert.equal(json(await run(bin, ['setup', '--client', 'cursor', '--cwd', project], { cwd: consumer })).status, 'unchanged');
    } finally { registry.closeAllConnections(); await new Promise(resolve => registry.close(resolve)); }
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
      if (rpc.method === 'initialize') {
        assert.deepEqual(rpc.params.clientInfo, { name: manifest.name, version: manifest.version });
        result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
      }
      else if (rpc.method === 'tools/list') result = { tools: [{ name: 'list_workspaces', inputSchema: { type: 'object' } }] };
      else { calls++; result = { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } }; }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/api/mcp`;
    try {
      const newProject = join(temp, 'one prompt project');
      await mkdir(newProject);
      const args = ['setup', '--client', 'cursor', '--cwd', '.', '--env-file', '.env', '--url', url, '--setup-code-stdin', '--confirm-existing-key'];
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
      assert.equal(report.status, 'completed');
      assert.deepEqual(Object.values(report.timings.stages).map(stage => stage.status), ['completed', 'completed', 'completed', 'completed']);
      const events = first.stderr.trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(events.filter(event => event.status === 'started').map(event => event.stage), ['preflight', 'credentials', 'install', 'connection']);
      assert.ok(events.every(event => event.type === 'steercards-setup-progress' && Number.isFinite(event.elapsedMs)));
      assert.ok(!first.stdout.includes(token) && !first.stderr.includes(token));
      assert.ok(!first.stdout.includes(code) && !first.stderr.includes(code));
      assert.equal(await readFile(join(newProject, '.env'), 'utf8'), `STEERCARDS_AGENT_KEY=${token}\n`);
      const pendingResult = await run(bin, args, { cwd: newProject, input: code + '\n' });
      const pending = json(pendingResult);
      assert.equal(pending.ok, false);
      assert.equal(pending.status, 'confirmation-required');
      assert.equal(pending.error, undefined);
      assert.equal(pending.setup, null);
      assert.equal(pending.confirmation.question, '.env에 Key가 있어요. 기존 키를 사용하시겠습니까?');
      assert.deepEqual(pending.confirmation.choices.map(choice => choice.flag), ['--keep-agent-key', '--replace-agent-key']);
      assert.equal(pending.timings.stages.install.status, 'pending');
      const kept = json(await run(bin, [...args, '--keep-agent-key'], { cwd: newProject, input: code + '\n' }));
      assert.equal(kept.credentials.status, 'kept');
      assert.equal(kept.timings.stages.credentials.status, 'skipped');
      assert.equal(exchanges, 1);
      const confirmationProject = join(temp, 'confirmation only');
      await mkdir(confirmationProject);
      await writeFile(join(confirmationProject, '.env'), `STEERCARDS_AGENT_KEY=${token}\n`);
      assert.equal(json(await run(bin, args, { cwd: confirmationProject, input: code + '\n' })).status, 'confirmation-required');
      assert.deepEqual(await readdir(confirmationProject), ['.env']);
      await rm(join(confirmationProject, '.env'));
      const missing = await run(bin, [...args, '--keep-agent-key'], { cwd: confirmationProject, input: code + '\n' });
      assert.equal(missing.status, 1);
      assert.equal(JSON.parse(missing.stdout).status, 'failed');
      assert.equal(exchanges, 1);
      assert.deepEqual(await readdir(confirmationProject), []);
      const replaced = json(await run(bin, [...args, '--replace-agent-key'], { cwd: newProject, input: code + '\n' }));
      assert.equal(replaced.credentials.status, 'saved');
      assert.equal(exchanges, 2);
      for (const result of [pendingResult, missing]) {
        assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token));
        assert.ok(!result.stdout.includes(code) && !result.stderr.includes(code));
      }
      if (process.platform === 'win32') {
        const psProject = join(consumer, 'powershell bootstrap');
        await mkdir(psProject);
        const quote = value => `'${value.replace(/'/g, "''")}'`;
        const npx = join(dirname(process.execPath), 'npx.ps1');
        const command = `@'\r\n${code}\r\n'@ | & ${quote(npx)} ${['--offline', '--', 'steercards', ...args].map(quote).join(' ')}`;
        const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { cwd: psProject });
        assert.equal(json(result).ok, true, result.stderr);
        assert.ok(!result.stdout.includes(token));
        assert.equal(exchanges, 3);
      }
      assert.ok(calls >= 2);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });

  await t.test('packed CLI exits at its deadline after HTTP 202 without an MCP result', async () => {
    // A report-only Promise.race passes stdout checks while leaving the SDK's
    // 60s request timer alive. Verify real process termination for all requests.
    await Promise.all(['initialize', 'tools/list', 'tools/call'].map(async stalled => {
      const code = `sc_install_${'C'.repeat(43)}`;
      const token = `sc_agent_${'T'.repeat(43)}`;
      const stalledProject = join(temp, `accepted ${stalled.replace('/', '-')}`);
      await mkdir(stalledProject);
      const original = `STEERCARDS_AGENT_KEY=${token}\n`;
      await writeFile(join(stalledProject, '.env'), original);
      const server = createServer(async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        let body = '';
        for await (const chunk of req) body += chunk;
        const rpc = JSON.parse(body);
        if (rpc.id === undefined || rpc.method === stalled) { res.writeHead(202); res.end(); return; }
        const result = rpc.method === 'initialize'
          ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
          : { tools: [{ name: 'list_workspaces', inputSchema: { type: 'object' } }] };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      try {
        const began = performance.now();
        const result = await run(bin, ['setup', '--client', 'cursor', '--cwd', stalledProject, '--env-file', '.env', '--setup-code-stdin', '--confirm-existing-key', '--keep-agent-key', '--url', `http://127.0.0.1:${server.address().port}/api/mcp`], { input: code + '\n' });
        const durationMs = performance.now() - began;
        assert.equal(result.status, 1, `${stalled}: ${result.stderr}`);
        assert.equal(result.signal, null);
        assert.ok(durationMs < 22000, `${stalled} process remained alive after deadline (${durationMs}ms)`);
        const report = JSON.parse(result.stdout);
        assert.equal(report.status, 'failed');
        assert.equal(report.doctor.connected, false);
        assert.equal(report.timings.stages.connection.status, 'failed');
        assert.ok(report.timings.stages.connection.durationMs >= 14500);
        assert.equal(await readFile(join(stalledProject, '.env'), 'utf8'), original);
        assert.ok(!`${result.stdout}${result.stderr}`.includes(token));
        assert.ok(!`${result.stdout}${result.stderr}`.includes(code));
      } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    }));
  });

  await t.test('real npx failure recovery preserves reused keys and hides server secrets', async () => {
    const code = `sc_install_${'C'.repeat(43)}`;
    const token = `sc_agent_${'T'.repeat(43)}`;
    const npx = process.platform === 'win32' ? join(dirname(process.execPath), 'npx.cmd') : 'npx';
    let requests = 0;
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      assert.equal(req.url, '/api/agent-setup/exchange');
      assert.equal(JSON.parse(body).code, code);
      requests++;
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'AGENT_INSTALL_KEY_TOKEN_MISMATCH', message: `untrusted-server-message ${token} ${code}` } }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const failedProject = join(temp, 'npx recovery 한글 project');
      await mkdir(failedProject);
      const original = '# preserved\r\nOTHER=value\r\n';
      await writeFile(join(failedProject, '.env'), original);
      const result = await run(npx, ['--offline', '--', 'steercards', 'setup', '--client', 'codex', '--cwd', failedProject, '--env-file', '.env', '--url', `http://127.0.0.1:${server.address().port}/api/mcp`, '--setup-code-stdin'], { cwd: consumer, input: code + '\n' });
      assert.equal(result.status, 1);
      const report = JSON.parse(result.stdout);
      assert.equal(report.credentials.status, 'not-saved');
      assert.match(report.error, /selected Agent Key could not be verified/);
      const steps = report.nextSteps.join(' ');
      assert.match(steps, /First check whether the project \.env contains the Agent Key/);
      assert.match(steps, /Preserve reused keys and create a new code for the same usable key/);
      assert.match(steps, /Only revoke a newly issued key if you explicitly confirm it is unused/);
      assert.equal(requests, 1);
      assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token));
      assert.ok(!result.stdout.includes(code) && !result.stderr.includes(code));
      assert.doesNotMatch(result.stdout + result.stderr, /untrusted-server-message/);
      assert.equal(await readFile(join(failedProject, '.env'), 'utf8'), original);
      await assert.rejects(readFile(join(failedProject, '.codex', 'config.toml')), { code: 'ENOENT' });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });

  assert.equal(await readFile(join(project, '.env'), 'utf8'), defaultFile);
  assert.equal(await readFile(join(project, 'alternate.env'), 'utf8'), selectedFile);
});
