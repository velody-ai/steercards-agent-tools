import assert from 'node:assert/strict';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, ListToolsResultSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../src/config.js';
import { Runtime } from '../src/runtime.js';
import { createServer, getGuide } from '../src/server.js';

const key = 'test-agent-key-DO-NOT-LOG';
const { name: packageName, version: packageVersion } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const schema: Tool = {
  name: 'read_card', title: 'Read a card', description: 'Read a card and its description.',
  inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false, 'x-custom-key': 'passthrough' },
  outputSchema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'], 'x-custom-output': true },
  annotations: { readOnlyHint: true, idempotentHint: true },
  _meta: { custom: 'metadata' },
};
const mutation: Tool = { name: 'create_card', description: 'Create a new card.', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }, annotations: { readOnlyHint: false } };
const success: CallToolResult = {
  content: [
    { type: 'text', text: 'exact upstream text' },
    { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    { type: 'resource_link', uri: 'https://cards.example/artifact', name: 'artifact', mimeType: 'text/markdown' },
  ],
  structuredContent: { ok: true, data: { card: { id: 17 } } },
  isError: false,
  _meta: { upstream: 'preserved' },
};
const failure: CallToolResult = { content: [{ type: 'text', text: 'Card not found' }], structuredContent: { ok: false, error: { code: 'CARD_NOT_FOUND', status: 404 } }, isError: true };

interface Rpc { jsonrpc: '2.0'; id?: string | number; method: string; params?: { cursor?: string; name?: string; arguments?: Record<string, unknown>; protocolVersion?: string; clientInfo?: { name: string; version: string } } }

async function fixture(t: TestContext, handler?: (rpc: Rpc, res: ServerResponse) => boolean) {
  const calls: Rpc[] = [];
  const seen: { method: string; authorization?: string; protocol?: string }[] = [];
  const tools = [structuredClone(schema), structuredClone(mutation)];
  const http = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    seen.push({ method: req.method ?? '', authorization: req.headers.authorization, protocol: req.headers['mcp-protocol-version'] as string | undefined });
    if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401); res.end('Unauthorized'); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body) as Rpc;
    assert.ok(!Array.isArray(rpc), 'JSON-RPC batches must never be sent');
    calls.push(rpc);
    if (handler?.(rpc, res)) return;
    if (rpc.id === undefined) { res.writeHead(202); res.end(); return; }
    let result: unknown;
    switch (rpc.method) {
      case 'initialize':
        assert.equal(rpc.params?.protocolVersion, '2025-11-25');
        assert.deepEqual(rpc.params?.clientInfo, { name: packageName, version: packageVersion });
        result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'stateless-test', version: '1' } }; break;
      case 'tools/list':
        result = rpc.params?.cursor === 'page-two' ? { tools: tools.slice(1) } : { tools: tools.slice(0, 1), nextCursor: 'page-two' }; break;
      case 'tools/call': result = rpc.params?.arguments?.fail ? failure : success; break;
      default: throw new Error(`Unexpected method ${rpc.method}`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const port = (http.address() as { port: number }).port;
  const cwd = await mkdtemp(join(tmpdir(), 'steercards-runtime-'));
  const url = `http://127.0.0.1:${port}/api/mcp`;
  const config = await loadConfig({ cwd, env: { STEERCARDS_AGENT_KEY: key, STEERCARDS_MCP_URL: url } });
  const runtime = new Runtime(config);
  t.after(async () => {
    await runtime.close();
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    await rm(cwd, { recursive: true, force: true });
  });
  return { runtime, calls, tools, seen, url, cwd };
}

test('SDK HTTP discovery follows pagination, caches defensively, refreshes, and discovers future tools', async t => {
  const f = await fixture(t);
  const tools = await f.runtime.listTools();
  assert.deepEqual(tools, f.tools);
  assert.equal(f.calls.filter(rpc => rpc.method === 'tools/list').length, 2);
  tools[0].name = 'corrupted-by-caller';
  assert.equal((await f.runtime.listTools())[0].name, 'read_card');
  assert.equal(f.calls.filter(rpc => rpc.method === 'tools/list').length, 2);
  const discovered: Tool = { name: 'future_tool', description: 'New server capability', inputSchema: { type: 'object' } };
  f.tools.push(discovered);
  assert.deepEqual((await f.runtime.searchTools('future_tool')).map(tool => tool.name), ['future_tool']);
  assert.equal(f.calls.filter(rpc => rpc.method === 'tools/list').length, 4);
  assert.deepEqual(await f.runtime.describeTool('future_tool'), discovered);
  const newer: Tool = { name: 'newer_tool', inputSchema: { type: 'object' } };
  f.tools.push(newer);
  assert.deepEqual(await f.runtime.describeTool('newer_tool'), newer);
  assert.equal(f.calls.filter(rpc => rpc.method === 'tools/list').length, 6);
  await f.runtime.listTools({ refresh: true });
  assert.equal(f.calls.filter(rpc => rpc.method === 'tools/list').length, 8);
  assert.ok(f.seen.every(request => request.authorization === `Bearer ${key}`));
  assert.ok(f.seen.some(request => request.protocol === '2025-11-25'));
});

test('search omits schemas, describe preserves JSON Schema and metadata, unknown tool is never called', async t => {
  const f = await fixture(t);
  const matches = await f.runtime.searchTools('card', 1);
  assert.equal(matches.length, 1);
  assert.ok(matches[0].name.endsWith('_card'));
  assert.equal('inputSchema' in matches[0], false);
  assert.equal('outputSchema' in matches[0], false);
  assert.deepEqual(await f.runtime.describeTool('read_card'), schema);
  await assert.rejects(f.runtime.callTool('not_available', {}), /Unknown Steercards tool/);
  assert.equal(f.calls.filter(rpc => rpc.method === 'tools/call').length, 0);
  await assert.rejects(f.runtime.searchTools('', 0), /limit/);
  await assert.rejects(f.runtime.callTool('read_card', [] as unknown as Record<string, unknown>), /JSON object/);
});

test('tool results preserve mixed content, structured data, metadata, and upstream errors', async t => {
  const { runtime } = await fixture(t);
  assert.deepEqual(await runtime.callTool('read_card', { id: 17 }), success);
  assert.deepEqual(await runtime.callTool('read_card', { id: 999, fail: true }), failure);
});

test('HTTP429 retains safe Retry-After diagnostics and never retries a mutation', async t => {
  const f = await fixture(t, (rpc, res) => {
    if (rpc.method !== 'tools/call') return false;
    res.writeHead(429, { 'Retry-After': '31' });
    res.end(`secret proxy body ${key}`);
    return true;
  });
  await assert.rejects(f.runtime.callTool('create_card', { title: 'once' }), error => {
    assert.match((error as Error).message, /429/);
    assert.match((error as Error).message, /Retry-After: 31/);
    assert.ok(!(error as Error).message.includes(key));
    return true;
  });
  assert.equal(f.calls.filter(rpc => rpc.method === 'tools/call').length, 1);
});

test('HTTP errors preserve validated product codes without leaking arbitrary error prose', async t => {
  const f = await fixture(t, (rpc, res) => {
    if (rpc.method !== 'tools/call') return false;
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'AGENT_AUDIT_UNAVAILABLE', message: `secret server error ${key}` } }));
    return true;
  });
  await assert.rejects(f.runtime.callTool('create_card', { title: 'once' }), error => {
    const message = (error as Error).message;
    assert.match(message, /503/);
    assert.match(message, /AGENT_AUDIT_UNAVAILABLE/);
    assert.match(message, /may have committed/);
    assert.ok(!message.includes(key));
    assert.ok(!message.includes('secret server error'));
    return true;
  });
  assert.equal(f.calls.filter(rpc => rpc.method === 'tools/call').length, 1);
});

test('HTTP error diagnostic bodies are size-bounded and arbitrary code text is rejected', async t => {
  const f = await fixture(t, (rpc, res) => {
    if (rpc.method !== 'tools/call') return false;
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: `not-a-machine-code-${key}`, message: 'x'.repeat(32 * 1024) } }));
    return true;
  });
  await assert.rejects(f.runtime.callTool('create_card', { title: 'once' }), error => {
    const message = (error as Error).message;
    assert.match(message, /403/);
    assert.ok(!message.includes(key));
    assert.ok(!message.includes('not-a-machine-code'));
    return true;
  });
});

test('a mutation whose response is lost is submitted once', async t => {
  const f = await fixture(t, (rpc, res) => {
    if (rpc.method !== 'tools/call') return false;
    res.destroy();
    return true;
  });
  await assert.rejects(f.runtime.callTool('create_card', { title: 'uncertain effect' }));
  assert.equal(f.calls.filter(rpc => rpc.method === 'tools/call').length, 1);
});

test('close aborts an unfinished HTTP initialize instead of waiting for a timeout', async t => {
  let received!: () => void;
  const initializing = new Promise<void>(resolve => { received = resolve; });
  const f = await fixture(t, (rpc, _res) => {
    if (rpc.method !== 'initialize') return false;
    received();
    return true;
  });
  const pending = f.runtime.listTools();
  const rejected = assert.rejects(pending);
  await initializing;
  await f.runtime.close();
  await rejected;
  await assert.rejects(f.runtime.listTools(), /closed/);
});

test('redirects are refused without sending credentials to the redirect target', async t => {
  let targetRequests = 0;
  const target = createHttpServer((_req, res) => { targetRequests++; res.writeHead(200); res.end(); });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  t.after(() => { target.closeAllConnections(); target.close(); });
  const f = await fixture(t, (rpc, res) => {
    if (rpc.method !== 'initialize') return false;
    res.writeHead(307, { Location: `http://127.0.0.1:${(target.address() as { port: number }).port}/stolen` });
    res.end();
    return true;
  });
  await assert.rejects(f.runtime.listTools());
  assert.equal(targetRequests, 0);
});

test('repeated pagination cursors fail instead of looping', async t => {
  const f = await fixture(t, (rpc, res) => {
    if (rpc.method !== 'tools/list') return false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [], nextCursor: 'loop' } }));
    return true;
  });
  await assert.rejects(f.runtime.listTools(), /pagination cursor/);
  assert.equal(f.calls.filter(rpc => rpc.method === 'tools/list').length, 2);
});

test('compact and full local MCP modes expose their contract and preserve upstream results', async t => {
  for (const mode of ['compact', 'full'] as const) {
    await t.test(mode, async t => {
      const f = await fixture(t);
      const server = createServer(f.runtime, { mode });
      const client = new Client({ name: 'local-test', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      t.after(async () => { await client.close(); await server.close(); });
      assert.deepEqual(client.getServerVersion(), { name: packageName, version: packageVersion });
      const instructions = client.getInstructions() ?? '';
      for (const contract of ['set_agent_status', 'clear_agent_status', 'working', 'waiting_for_input', 'question', 'error', '5 minutes', '10-minute', 'claimFence', 'run heartbeat', 'read-only lookups', 'even when the turn ends']) {
        assert.ok(instructions.includes(contract), `initialize must expose card-work guidance for ${contract}`);
      }
      for (const contract of ['search_cards', 'both titles and bodies', 'explore_cards', 'known workspace/board/path', 'Do not repeat known directory listings', 'return the card list immediately', 'Do not reread matching content', 'all input options']) {
        assert.ok(instructions.includes(contract), `initialize must expose search guidance for ${contract}`);
      }
      const list = await client.request({ method: 'tools/list' }, ListToolsResultSchema);
      if (mode === 'compact') {
        assert.deepEqual(list.tools.map(tool => tool.name), ['steercards_search_tools', 'steercards_describe_tool', 'steercards_call_tool', 'steercards_get_guide']);
        assert.equal(f.calls.length, 0, 'compact registration must not connect upstream or expose its schemas');
        const workGuidanceStart = instructions.indexOf('Before actual card work');
        assert.ok(workGuidanceStart >= 0);
        const workGuidance = instructions.slice(workGuidanceStart);
        assert.ok(list.tools.find(tool => tool.name === 'steercards_call_tool')?.description?.includes(workGuidance), 'hosts showing only tool metadata must receive the same work contract');
        assert.equal(list.tools.filter(tool => tool.description?.includes('set_agent_status')).length, 1, 'do not repeat the full contract on every compact tool');
        const searchGuidance = instructions.slice(instructions.indexOf('Use search_cards'), instructions.indexOf(' Read the Steercards guide'));
        assert.ok(list.tools.find(tool => tool.name === 'steercards_search_tools')?.description?.includes(searchGuidance), 'metadata-only hosts must receive the same search choice and stopping rules');
        const search = await client.callTool({ name: 'steercards_search_tools', arguments: { query: 'read_card' } });
        assert.equal(JSON.stringify(search).includes('inputSchema'), false);
        const described = await client.callTool({ name: 'steercards_describe_tool', arguments: { name: 'read_card' } });
        assert.deepEqual(described.structuredContent, { tool: schema });
      } else assert.deepEqual(list.tools, f.tools);
      const called = await client.request({ method: 'tools/call', params: mode === 'compact'
        ? { name: 'steercards_call_tool', arguments: { name: 'read_card', arguments: { id: 17 } } }
        : { name: 'read_card', arguments: { id: 17 } } }, CallToolResultSchema);
      assert.deepEqual(called, success);
      const resources = await client.listResources();
      assert.equal(resources.resources.length, 9);
      const guide = await client.readResource({ uri: 'steercards://guide/overview' });
      assert.match(String(guide.contents[0].text), /Steercards/i);
      assert.ok(String(guide.contents[0].text).includes('clear_agent_status'), 'bundled overview must include the default card-work flow');
    });
  }
});

test('real stdio transport keeps stdout as MCP frames and closes upstream on EOF', async t => {
  const f = await fixture(t);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const code = [
    `import {loadConfig} from ${JSON.stringify(new URL('../src/config.ts', import.meta.url).href)};`,
    `import {Runtime} from ${JSON.stringify(new URL('../src/runtime.ts', import.meta.url).href)};`,
    `import {startServer} from ${JSON.stringify(new URL('../src/server.ts', import.meta.url).href)};`,
    `const config = await loadConfig({cwd:${JSON.stringify(f.cwd)},env:{STEERCARDS_AGENT_KEY:${JSON.stringify(key)},STEERCARDS_MCP_URL:${JSON.stringify(f.url)}}});`,
    'await startServer(new Runtime(config),{mode:"compact"});',
  ].join('\n');
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', '--input-type=module', '-e', code], cwd: root, stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '1' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  t.after(() => client.close());
  await client.connect(transport);
  assert.deepEqual(client.getServerVersion(), { name: packageName, version: packageVersion });
  const list = await client.listTools();
  assert.equal(list.tools.length, 4);
  const result = await client.callTool({ name: 'steercards_call_tool', arguments: { name: 'read_card', arguments: { id: 17 } } });
  assert.deepEqual(result, success);
  assert.ok(!stderr.includes(key));
  await client.close();
});

test('guides reject path traversal and support each documented topic', async () => {
  await assert.rejects(getGuide('../../etc/passwd'), /Unknown guide topic/);
  for (const topic of ['overview', 'discovery', 'exploration', 'cards', 'profiles', 'claims-runs', 'context', 'files', 'collaboration']) {
    assert.ok((await getGuide(topic)).length > 30);
  }
});
