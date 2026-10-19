import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { setup } from '../src/setup.js';
import { setupWithCode } from '../src/setup-with-code.js';

const code = `sc_install_${'C'.repeat(43)}`;
const token = `sc_agent_${'T'.repeat(43)}`;
const receipt = { installationId: 'cda81bb1-80c4-43bf-99ec-362f2f3b9d97', key: { id: 'd64b013e-9338-45e0-b95b-eb162df86e58' }, profileIds: [] };
const response = () => Response.json({ ...receipt, token });
const doctor = async () => ({ connected: true, keySource: 'env-file' as const, toolCount: 1 });
async function fixture(t: TestContext) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'steercards-bootstrap-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('one prompt exchanges once, writes only env credentials, installs MCP and skill, and keeps key on rerun', async t => {
  const cwd = await fixture(t);
  let exchanges = 0;
  const fetcher: typeof fetch = async (url, init) => {
    exchanges++;
    assert.equal(url.toString(), 'https://steercards.com/api/agent-setup/exchange');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.body, JSON.stringify({ code }));
    return response();
  };
  const options = { client: 'cursor', cwd, envFile: '.env', code };
  const first = await setupWithCode(options, { fetch: fetcher, doctor });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.credentials.status, 'saved');
  assert.equal(exchanges, 1);
  assert.equal(await readFile(join(cwd, '.env'), 'utf8'), `STEERCARDS_AGENT_KEY=${token}\n`);
  const config = await readFile(first.setup!.paths.config, 'utf8');
  const manifest = await readFile(first.setup!.paths.manifest, 'utf8');
  for (const text of [JSON.stringify(first), config, manifest]) { assert.ok(!text.includes(token)); assert.ok(!text.includes(code)); }
  assert.ok((await readFile(join(cwd, '.cursor', 'skills', 'steercards', 'SKILL.md'), 'utf8')).length > 0);
  const second = await setupWithCode(options, { fetch: fetcher, doctor });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.setup?.status, 'unchanged');
  assert.equal(second.credentials.status, 'kept');
  assert.equal(exchanges, 1);
});

test('config conflict, custom env and missing cwd fail before exchanging; explicit env transition works', async t => {
  const cwd = await fixture(t);
  let exchanges = 0;
  const deps = { fetch: async () => { exchanges++; return response(); }, doctor };
  await mkdir(join(cwd, '.cursor'));
  await writeFile(join(cwd, '.cursor', 'mcp.json'), '{"mcpServers":{"steercards":{"command":"user-owned"}}}');
  assert.equal((await setupWithCode({ client: 'cursor', cwd, code }, deps)).ok, false);
  assert.equal(exchanges, 0);
  await rm(join(cwd, '.cursor'), { recursive: true });
  await setup({ client: 'cursor', cwd, envFile: 'alternate.env' });
  const conflict = await setupWithCode({ client: 'cursor', cwd, code }, deps);
  assert.equal(conflict.ok, false);
  assert.match(conflict.error!, /Explicitly select/);
  assert.equal(exchanges, 0);
  assert.equal((await setupWithCode({ client: 'cursor', cwd: join(cwd, 'missing'), code }, deps)).ok, false);
  assert.equal(exchanges, 0);
  const fixed = await setupWithCode({ client: 'cursor', cwd, envFile: '.env', code }, deps);
  assert.equal(fixed.ok, true, fixed.error);
  assert.equal(exchanges, 1);
});

test('dry run performs no exchange and does not create project files', async t => {
  const cwd = await fixture(t);
  let requests = 0;
  const report = await setupWithCode({ client: 'codex', cwd, code, dryRun: true }, { fetch: async () => { requests++; return response(); }, doctor });
  assert.equal(report.ok, true, report.error);
  assert.equal(report.credentials.status, 'dry-run');
  assert.equal(requests, 0);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(cwd), []);
});

test('saved key survives later config write failure and plain setup recovers without exchange', async t => {
  const cwd = await fixture(t);
  let requests = 0;
  const report = await setupWithCode({ client: 'cursor', cwd, code }, {
    fetch: async () => { requests++; return response(); }, doctor,
    setup: { beforeWrite: async (_path, index) => { if (index === 1) throw new Error(`fixture failure ${token} ${code}`); } },
  });
  assert.equal(report.ok, false);
  assert.equal(report.credentials.status, 'saved');
  assert.equal(requests, 1);
  assert.ok(!JSON.stringify(report).includes(token));
  assert.ok(!JSON.stringify(report).includes(code));
  assert.equal(await readFile(join(cwd, '.env'), 'utf8'), `STEERCARDS_AGENT_KEY=${token}\n`);
  await assert.rejects(readFile(join(cwd, '.cursor', 'mcp.json')), { code: 'ENOENT' });
  const recovered = await setup({ client: 'cursor', cwd, envFile: '.env', url: 'https://steercards.com/api/mcp' });
  assert.equal(recovered.status, 'installed');
  assert.equal(requests, 1);
});

test('env write conflict after exchange retains external edit and gives safe key cleanup receipt', async t => {
  const cwd = await fixture(t);
  const report = await setupWithCode({ client: 'codex', cwd, code }, {
    fetch: async () => { await writeFile(join(cwd, '.env'), 'OTHER=external\n'); return response(); }, doctor,
  });
  assert.equal(report.ok, false);
  assert.equal(report.credentials.status, 'not-saved');
  assert.equal(report.receipt?.keyId, receipt.key.id);
  assert.match(report.error!, /could not be saved/);
  assert.ok(!JSON.stringify(report).includes(token));
  assert.equal(await readFile(join(cwd, '.env'), 'utf8'), 'OTHER=external\n');
});

test('remote failures are bounded, never expose response prose or credentials, and never retry', async t => {
  for (const fetcher of [
    async () => Response.json({ error: { code: 'AGENT_INSTALL_CODE_CONSUMED', message: `${token} ${code}` } }, { status: 409 }),
    async () => Response.json({ error: { code: token, message: code } }, { status: 403 }),
    async () => Response.json({ token: `${token}\ninjected`, ...receipt }),
    async () => new Response(token + code),
    async () => new Response('{broken ' + token, { headers: { 'Content-Type': 'application/json' } }),
    async () => Response.json({ huge: 'x'.repeat(65 * 1024), token }),
    async () => { throw new Error(`${token} ${code}`); },
  ]) {
    const cwd = await fixture(t);
    let requests = 0;
    const report = await setupWithCode({ client: 'cursor', cwd, code }, { fetch: async () => { requests++; return fetcher(); }, doctor });
    assert.equal(report.ok, false);
    assert.equal(requests, 1);
    assert.ok(!JSON.stringify(report).includes(token));
    assert.ok(!JSON.stringify(report).includes(code));
    await assert.rejects(readFile(join(cwd, '.env')), { code: 'ENOENT' });
  }
});

test('code exchange rejects unsafe URLs and implicit different env origin before requesting', async t => {
  for (const url of ['http://remote.example/api/mcp', 'https://user:pass@example.com/api/mcp', 'https://example.com/api/mcp?q=1', 'https://example.com/api/mcp#fragment']) {
    const cwd = await fixture(t);
    let requests = 0;
    const report = await setupWithCode({ client: 'cursor', cwd, code, url }, { fetch: async () => { requests++; return response(); }, doctor });
    assert.equal(report.ok, false);
    assert.equal(requests, 0);
  }
  const cwd = await fixture(t);
  await writeFile(join(cwd, '.env'), 'STEERCARDS_MCP_URL=https://other.example/api/mcp\n');
  let requests = 0;
  const report = await setupWithCode({ client: 'cursor', cwd, code }, { fetch: async () => { requests++; return response(); }, doctor });
  assert.equal(report.ok, false);
  assert.match(report.error!, /Explicitly select/);
  assert.equal(requests, 0);
});

test('actual exchange and MCP doctor use stored file key instead of invoking environment', async t => {
  const cwd = await fixture(t);
  let exchanges = 0, calls = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/agent-setup/exchange') {
      assert.equal(JSON.parse(body).code, code); exchanges++;
      res.end(JSON.stringify({ ...receipt, token })); return;
    }
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const rpc = JSON.parse(body);
    if (rpc.id === undefined) { res.writeHead(202); res.end(); return; }
    let result;
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } };
    else if (rpc.method === 'tools/list') result = { tools: [{ name: 'list_workspaces', inputSchema: { type: 'object' } }] };
    else { calls++; result = { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }], structuredContent: { ok: true } }; }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const previous = process.env.STEERCARDS_AGENT_KEY;
  const previousUrl = process.env.STEERCARDS_MCP_URL;
  process.env.STEERCARDS_AGENT_KEY = 'wrong-inherited-key';
  process.env.STEERCARDS_MCP_URL = 'https://wrong.example/api/mcp';
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/mcp`;
    const report = await setupWithCode({ client: 'codex', cwd, code, url, envFile: '.env' });
    assert.equal(report.ok, true, report.error);
    assert.equal(report.doctor.keySource, 'env-file');
    assert.equal(exchanges, 1); assert.equal(calls, 1);
    assert.ok(!JSON.stringify(report).includes(token));
  } finally {
    if (previous === undefined) delete process.env.STEERCARDS_AGENT_KEY; else process.env.STEERCARDS_AGENT_KEY = previous;
    if (previousUrl === undefined) delete process.env.STEERCARDS_MCP_URL; else process.env.STEERCARDS_MCP_URL = previousUrl;
  }
});
