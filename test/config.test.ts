import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_MCP_URL, loadConfig, validateMcpUrl } from '../src/config.js';

async function directory(t: { after: (fn: () => Promise<void>) => void }) {
  const path = await mkdtemp(join(tmpdir(), 'steercards-config-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('reads only the selected cwd .env and environment values override file values without hydration', async t => {
  const cwd = await directory(t);
  const file = 'STEERCARDS_AGENT_KEY=file-key\nSTEERCARDS_MCP_URL=https://file.example/api/mcp\nSTEERCARDS_TEST_UNUSED=do-not-hydrate\n';
  await writeFile(join(cwd, '.env'), file);
  const env = { STEERCARDS_AGENT_KEY: 'environment-key', STEERCARDS_MCP_URL: 'https://env.example/api/mcp' };
  const config = await loadConfig({ cwd, env });
  assert.deepEqual(config, { cwd, envFile: join(cwd, '.env'), keySource: 'environment', agentKey: 'environment-key', url: 'https://env.example/api/mcp' });
  assert.deepEqual(env, { STEERCARDS_AGENT_KEY: 'environment-key', STEERCARDS_MCP_URL: 'https://env.example/api/mcp' });
  assert.equal(process.env.STEERCARDS_TEST_UNUSED, undefined);
  assert.equal(await readFile(join(cwd, '.env'), 'utf8'), file);
  assert.equal((await loadConfig({ cwd, env, url: 'https://flag.example/api/mcp' })).url, 'https://flag.example/api/mcp');
});

test('does not search parent directories and does not evaluate dotenv values', async t => {
  const cwd = await directory(t);
  await writeFile(join(cwd, '.env'), 'STEERCARDS_AGENT_KEY=parent-key');
  const child = join(cwd, 'child');
  await mkdir(child);
  await assert.rejects(loadConfig({ cwd: child, env: {} }), /Set STEERCARDS_AGENT_KEY/);
  await writeFile(join(child, '.env'), 'STEERCARDS_AGENT_KEY="${PARENT_SECRET}"\nIGNORED=$(touch /tmp/never-execute)');
  const config = await loadConfig({ cwd: child, env: { PARENT_SECRET: 'expanded-secret' } });
  assert.equal(config.agentKey, '${PARENT_SECRET}');
  assert.equal(config.keySource, 'env-file');
  assert.equal(config.url, DEFAULT_MCP_URL);
});

test('explicit env file resolves relative to cwd, supports absolute paths, and missing selected file fails', async t => {
  const cwd = await directory(t);
  await mkdir(join(cwd, 'config'));
  await writeFile(join(cwd, 'config', 'agent.env'), 'STEERCARDS_AGENT_KEY=explicit-key');
  const relative = await loadConfig({ cwd, envFile: 'config/agent.env', env: {} });
  assert.equal(relative.envFile, join(cwd, 'config', 'agent.env'));
  assert.equal(relative.agentKey, 'explicit-key');
  assert.deepEqual(await loadConfig({ cwd, envFile: relative.envFile, env: {} }), relative);
  await assert.rejects(loadConfig({ cwd, envFile: 'missing.env', env: { STEERCARDS_AGENT_KEY: 'from-env' } }), /Unable to read/);
  await assert.rejects(loadConfig({ cwd: join(cwd, 'missing'), env: {} }), /working directory/);
});

test('an explicitly empty environment key never falls back to a file and errors do not echo secrets', async t => {
  const cwd = await directory(t);
  await writeFile(join(cwd, '.env'), 'STEERCARDS_AGENT_KEY=file-key');
  for (const key of ['', 'sensitive-key\ninjected', 'sensitive key']) {
    await assert.rejects(loadConfig({ cwd, env: { STEERCARDS_AGENT_KEY: key } }), error => {
      assert.match((error as Error).message, /STEERCARDS_AGENT_KEY/);
      assert.ok(!(error as Error).message.includes('sensitive'));
      return true;
    });
  }
});

test('URL validation requires HTTPS remotely, permits exact local loopback, and rejects embedded secrets', () => {
  for (const url of ['https://cards.example/api/mcp', 'http://localhost:5174/api/mcp', 'http://127.0.0.1:4500/api/mcp', 'http://[::1]:4500/api/mcp']) {
    assert.equal(validateMcpUrl(url), url);
  }
  for (const url of [
    'http://cards.example/api/mcp', 'http://localhost.evil.example/api/mcp', 'file:///private/secrets',
    'https://user:secret@cards.example/api/mcp', 'https://cards.example/api/mcp?key=secret',
    'https://cards.example/api/mcp#secret', 'invalid-secret',
  ]) {
    assert.throws(() => validateMcpUrl(url), error => {
      assert.ok(!(error as Error).message.includes('secret'));
      return true;
    });
  }
});
