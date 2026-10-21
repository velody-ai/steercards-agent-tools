import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { setup } from '../src/setup.js';
import { setupWithCode } from '../src/setup-with-code.js';
import type { SetupProgressEvent } from '../src/setup-progress.js';

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
function assertPreservingRecovery(report: Awaited<ReturnType<typeof setupWithCode>>) {
  const steps = report.nextSteps.join(' ');
  assert.match(steps, /First check whether the project \.env contains the Agent Key/);
  assert.match(steps, /preserve any saved key and rerun setup without a code/);
  assert.match(steps, /check the code status and selected key in Steercards/);
  assert.match(steps, /Preserve reused keys and create a new code for the same usable key/);
  assert.match(steps, /Only revoke a newly issued key if you explicitly confirm it is unused/);
  assert.match(steps, /Do not replay it/);
  assert.doesNotMatch(JSON.stringify(report), /remove any unused issued Agent Key/);
}

test('existing-key confirmation is read-only, safe, and distinct from failure or success', async t => {
  const cwd = await fixture(t);
  const original = `# keep\r\nSTEERCARDS_AGENT_KEY=${token}\r\nOTHER=unchanged\r\n`;
  await writeFile(join(cwd, '.env'), original);
  // A config conflict is only considered after the user chooses a key.
  await mkdir(join(cwd, '.cursor'));
  await writeFile(join(cwd, '.cursor', 'mcp.json'), '{"mcpServers":{"steercards":{"command":"user-owned"}}}');
  const before = await readdir(cwd, { recursive: true });
  const events: SetupProgressEvent[] = [];
  let requests = 0, checks = 0, preflights = 0;
  const report = await setupWithCode({ client: 'cursor', cwd, code, confirmExistingKey: true, onProgress: event => events.push(event) }, {
    fetch: async () => { requests++; return response(); },
    doctor: async () => { checks++; return doctor(); },
    setup: { beforeCommit: async () => { preflights++; } },
  });
  assert.equal(report.ok, false);
  assert.equal(report.status, 'confirmation-required');
  assert.equal(report.error, undefined);
  assert.equal(report.setup, null);
  assert.equal(report.confirmation?.question, '.env에 Key가 있어요. 기존 키를 사용하시겠습니까?');
  assert.deepEqual(report.confirmation?.choices.map(choice => choice.flag), ['--keep-agent-key', '--replace-agent-key']);
  assert.equal(requests + checks + preflights, 0);
  assert.deepEqual(await readdir(cwd, { recursive: true }), before);
  assert.equal(await readFile(join(cwd, '.env'), 'utf8'), original);
  assert.deepEqual(events.map(event => [event.stage, event.status]), [['preflight', 'started'], ['preflight', 'completed']]);
  assert.equal(report.timings.stages.credentials.status, 'pending');
  assert.equal(report.timings.stages.install.status, 'pending');
  assert.equal(report.timings.stages.connection.status, 'pending');
  assert.ok(Number.isFinite(report.timings.totalMs));
  for (const secret of [token, code]) assert.ok(!JSON.stringify({ report, events }).includes(secret));
});

test('confirmed keep skips exchange, replace exchanges once, and missing keep never issues credentials', async t => {
  for (const choice of ['keep', 'replace', 'missing'] as const) {
    const cwd = await fixture(t);
    const existing = `sc_agent_${'E'.repeat(43)}`;
    if (choice !== 'missing') await writeFile(join(cwd, '.env'), `STEERCARDS_AGENT_KEY=${existing}\n`);
    let requests = 0;
    const events: SetupProgressEvent[] = [];
    const report = await setupWithCode({ client: 'cursor', cwd, code, confirmExistingKey: true,
      keepAgentKey: choice !== 'replace', replaceAgentKey: choice === 'replace', onProgress: event => events.push(event),
    }, { fetch: async () => { requests++; return response(); }, doctor });
    assert.equal(report.ok, choice !== 'missing', report.error);
    assert.equal(requests, choice === 'replace' ? 1 : 0);
    if (choice === 'missing') {
      assert.equal(report.status, 'failed');
      assert.match(report.error!, /no longer contains an Agent Key/);
      assert.equal(report.timings.stages.preflight.status, 'failed');
      assert.equal(report.timings.stages.connection.status, 'pending');
      assert.deepEqual(await readdir(cwd), []);
    } else {
      assert.equal(report.status, 'completed');
      assert.equal(report.credentials.status, choice === 'keep' ? 'kept' : 'saved');
      assert.equal(await readFile(join(cwd, '.env'), 'utf8'), `STEERCARDS_AGENT_KEY=${choice === 'keep' ? existing : token}\n`);
      assert.equal(report.timings.stages.credentials.status, choice === 'keep' ? 'skipped' : 'completed');
      assert.equal(report.timings.stages.install.status, 'completed');
      assert.equal(report.timings.stages.connection.status, 'completed');
      assert.deepEqual(events.filter(event => event.status === 'started').map(event => event.stage), ['preflight', 'credentials', 'install', 'connection']);
    }
  }
});

test('confirmation protects empty or ambiguous env assignments and mutually exclusive choices', async t => {
  for (const text of ['STEERCARDS_AGENT_KEY=\n', 'STEERCARDS_AGENT_KEY=one\nSTEERCARDS_AGENT_KEY=two\n', 'OTHER="unterminated\n', 'STEERCARDS_AGENT_KEY="value" garbage\n']) {
    for (const selected of [{}, { keepAgentKey: true }, { replaceAgentKey: true }]) {
      const cwd = await fixture(t);
      await writeFile(join(cwd, '.env'), text);
      let requests = 0;
      const report = await setupWithCode({ client: 'cursor', cwd, code, confirmExistingKey: true, ...selected }, { fetch: async () => { requests++; return response(); }, doctor });
      assert.equal(report.status, 'failed');
      assert.equal(requests, 0);
      assert.equal(await readFile(join(cwd, '.env'), 'utf8'), text);
      assert.deepEqual(await readdir(cwd), ['.env']);
    }
  }
  const cwd = await fixture(t);
  const report = await setupWithCode({ client: 'cursor', cwd, code, keepAgentKey: true, replaceAgentKey: true });
  assert.equal(report.status, 'failed');
  assert.match(report.error!, /Choose only one/);
  assert.deepEqual(await readdir(cwd), []);
});

test('key appearing or disappearing during preflight is never exchanged without the right choice', async t => {
  for (const keep of [false, true]) {
    const cwd = await fixture(t);
    if (keep) await writeFile(join(cwd, '.env'), `STEERCARDS_AGENT_KEY=${token}\n`);
    let requests = 0;
    const report = await setupWithCode({ client: 'cursor', cwd, code, confirmExistingKey: true, keepAgentKey: keep }, {
      fetch: async () => { requests++; return response(); }, doctor,
      setup: { beforeCommit: async () => {
        if (keep) await rm(join(cwd, '.env'));
        else await writeFile(join(cwd, '.env'), `STEERCARDS_AGENT_KEY=${token}\n`);
      } },
    });
    assert.equal(report.status, keep ? 'failed' : 'confirmation-required');
    assert.equal(requests, 0);
    await assert.rejects(readFile(join(cwd, '.cursor', 'mcp.json')), { code: 'ENOENT' });
  }
});

test('connection deadline aborts stalled HTTP headers and bodies and returns without waiting for close', async t => {
  for (const body of [false, true]) {
    const cwd = await fixture(t);
    await writeFile(join(cwd, '.env'), `STEERCARDS_AGENT_KEY=${token}\n`);
    let disconnected = false;
    const server = createServer((req, res) => {
      req.resume();
      res.once('close', () => { disconnected = true; });
      if (body) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.write('{"error":'); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const began = performance.now();
    const report = await setupWithCode({ client: 'cursor', cwd, code, keepAgentKey: true, url: `http://127.0.0.1:${(server.address() as any).port}/api/mcp` }, { connectionTimeoutMs: 100 });
    assert.equal(report.status, 'failed');
    assert.equal(report.doctor.connected, false);
    assert.equal(report.timings.stages.connection.status, 'failed');
    assert.ok(performance.now() - began < 2000);
    // The abort must release the actual socket, not merely race the report promise.
    for (let i = 0; i < 20 && !disconnected; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(disconnected, true);
    assert.equal(await readFile(join(cwd, '.env'), 'utf8'), `STEERCARDS_AGENT_KEY=${token}\n`);
  }
});

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
  assert.equal(report.status, 'dry-run');
  assert.deepEqual(Object.values(report.timings.stages).map(stage => stage.status), ['completed', 'skipped', 'skipped', 'skipped']);
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
  assert.equal(report.timings.stages.install.status, 'failed');
  assert.equal(report.timings.stages.connection.status, 'pending');
  assert.ok(report.timings.totalMs >= report.timings.stages.install.durationMs);
  assert.equal(requests, 1);
  assert.ok(!JSON.stringify(report).includes(token));
  assert.ok(!JSON.stringify(report).includes(code));
  assert.equal(await readFile(join(cwd, '.env'), 'utf8'), `STEERCARDS_AGENT_KEY=${token}\n`);
  await assert.rejects(readFile(join(cwd, '.cursor', 'mcp.json')), { code: 'ENOENT' });
  const recovered = await setup({ client: 'cursor', cwd, envFile: '.env', url: 'https://steercards.com/api/mcp' });
  assert.equal(recovered.status, 'installed');
  assert.equal(requests, 1);
});

test('env write conflict after exchange retains external edit and gives key-preserving recovery', async t => {
  const cwd = await fixture(t);
  const report = await setupWithCode({ client: 'codex', cwd, code }, {
    fetch: async () => { await writeFile(join(cwd, '.env'), 'OTHER=external\n'); return response(); }, doctor,
  });
  assert.equal(report.ok, false);
  assert.equal(report.credentials.status, 'not-saved');
  assert.equal(report.receipt?.keyId, receipt.key.id);
  assert.match(report.error!, /could not be saved/);
  assertPreservingRecovery(report);
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
    assertPreservingRecovery(report);
    assert.ok(!JSON.stringify(report).includes(token));
    assert.ok(!JSON.stringify(report).includes(code));
    await assert.rejects(readFile(join(cwd, '.env')), { code: 'ENOENT' });
  }
});

test('existing-key errors use safe static messages and preserve unrelated env data', async t => {
  for (const [errorCode, expected] of [
    ['AGENT_INSTALL_KEY_NOT_FOUND', /selected Agent Key is no longer available/],
    ['AGENT_INSTALL_KEY_REVOKED', /selected Agent Key was revoked/],
    ['AGENT_INSTALL_KEY_EXPIRED', /selected Agent Key expired/],
    ['AGENT_INSTALL_KEY_ACCESS_CHANGED', /selected Agent Key access changed/],
    ['AGENT_INSTALL_KEY_TOKEN_MISMATCH', /selected Agent Key could not be verified/],
    ['AGENT_INSTALL_KEY_CAPSULE_INVALID', /could not restore the selected Agent Key/],
  ] as const) {
    const cwd = await fixture(t);
    const original = '# keep comments\r\nOTHER=value\r\n';
    await writeFile(join(cwd, '.env'), original);
    let requests = 0;
    const report = await setupWithCode({ client: 'codex', cwd, code }, {
      fetch: async () => {
        requests++;
        return Response.json({ error: { code: errorCode, message: `untrusted-server-message ${token} ${code}` } }, { status: 409 });
      }, doctor,
    });
    assert.equal(report.ok, false);
    assert.equal(report.credentials.status, 'not-saved');
    assert.equal(requests, 1);
    assert.match(report.error!, expected);
    assertPreservingRecovery(report);
    assert.doesNotMatch(JSON.stringify(report), /untrusted-server-message/);
    assert.ok(!JSON.stringify(report).includes(token));
    assert.ok(!JSON.stringify(report).includes(code));
    assert.equal(await readFile(join(cwd, '.env'), 'utf8'), original);
  }
});

test('kept key survives config failure without exchanging or changing env bytes', async t => {
  const cwd = await fixture(t);
  const original = `# shared existing key\r\nSTEERCARDS_AGENT_KEY=${token}\r\nOTHER=value\r\n`;
  await writeFile(join(cwd, '.env'), original);
  let requests = 0;
  const report = await setupWithCode({ client: 'cursor', cwd, code }, {
    fetch: async () => { requests++; return response(); }, doctor,
    setup: { beforeWrite: async (_path, index) => { if (index === 1) throw new Error('fixture failure'); } },
  });
  assert.equal(report.ok, false);
  assert.equal(report.credentials.status, 'kept');
  assert.equal(requests, 0);
  assert.match(report.nextSteps.join(' '), /\.env was preserved.*setup without an installation code/);
  assert.equal(await readFile(join(cwd, '.env'), 'utf8'), original);
  await setup({ client: 'cursor', cwd, envFile: '.env' });
  assert.equal(requests, 0);
  assert.equal(await readFile(join(cwd, '.env'), 'utf8'), original);
});

test('failed doctor preserves saved and kept keys and never asks to exchange again', async t => {
  for (const kept of [false, true]) {
    const cwd = await fixture(t);
    const original = `STEERCARDS_AGENT_KEY=${token}\n`;
    if (kept) await writeFile(join(cwd, '.env'), original);
    let requests = 0;
    const report = await setupWithCode({ client: 'cursor', cwd, code }, {
      fetch: async () => { requests++; return response(); },
      doctor: async () => { throw new Error(`untrusted-doctor-message ${token} ${code}`); },
    });
    assert.equal(report.ok, false);
    assert.equal(report.credentials.status, kept ? 'kept' : 'saved');
    assert.equal(report.doctor.connected, false);
    assert.equal(requests, kept ? 0 : 1);
    assert.match(report.nextSteps.join(' '), /Credentials and setup were preserved.*Do not redeem the code again/);
    assert.equal(await readFile(join(cwd, '.env'), 'utf8'), original);
    assert.ok(!JSON.stringify(report).includes(token));
    assert.ok(!JSON.stringify(report).includes(code));
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
