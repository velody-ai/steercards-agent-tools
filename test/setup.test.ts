import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile, readFile, rm, realpath, readdir, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseJsonc } from 'jsonc-parser';
import { unzipSync, strFromU8 } from 'fflate';
import { refreshManagedSetup, setup, type SetupOptions } from '../src/setup.js';
import { clientConfig } from '../src/install.js';

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'steercards-setup-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project with spaces');
  const home = join(root, 'home');
  const source = join(root, 'source');
  await mkdir(cwd);
  await mkdir(home);
  await mkdir(join(source, 'references'), { recursive: true });
  await writeFile(join(source, 'SKILL.md'), '---\nname: steercards\ndescription: Manage Steercards\n---\nGuide v1');
  await writeFile(join(source, 'references', 'work.md'), 'Work v1');
  return { root, cwd, home, source };
}

async function put(path: string, data: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

async function tree(root: string, prefix = ''): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const file of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${file.name}` : file.name;
    if (file.isDirectory()) Object.assign(entries, await tree(root, path));
    else if (file.isFile()) entries[path] = (await readFile(join(root, path))).toString('base64');
    else entries[path] = 'symlink-or-special';
  }
  return entries;
}

for (const client of ['codex', 'claude-code', 'cursor']) {
  test(`${client}: accepts manually merged managed files only when they exactly match the incoming bundle`, async t => {
    const { cwd, source } = await fixture(t);
    for (const name of ['claims-runs', 'collaboration']) await put(join(source, 'references', `${name}.md`), `Previous ${name}`);
    const installed = await setup({ client, cwd }, { source, version: '0.2.2' });
    const config = await readFile(installed.paths.config), manifest = await readFile(installed.paths.manifest);
    await writeFile(join(cwd, '.env'), 'STEERCARDS_AGENT_KEY=preserve-merged-skill-key\r\nOTHER=kept\r\n');
    const env = await readFile(join(cwd, '.env'));
    await put(join(installed.paths.skill!, 'user-notes.md'), 'Keep independent custom notes');
    for (const name of ['SKILL.md', 'references/claims-runs.md', 'references/collaboration.md']) {
      const incoming = `Incoming ${name}`;
      await writeFile(join(source, name), incoming);
      await writeFile(join(installed.paths.skill!, name), incoming);
    }
    await writeFile(join(source, 'references', 'work.md'), 'Remaining update');
    assert.deepEqual(await readFile(installed.paths.manifest), manifest, 'manual merge leaves the old ownership record intact');
    const updated = await setup({ client, cwd }, { source, version: '0.2.3' });
    assert.equal(updated.status, 'updated');
    assert.equal(JSON.parse(await readFile(installed.paths.manifest, 'utf8')).version, '0.2.3');
    assert.equal(await readFile(join(installed.paths.skill!, 'references', 'work.md'), 'utf8'), 'Remaining update');
    assert.equal(await readFile(join(installed.paths.skill!, 'user-notes.md'), 'utf8'), 'Keep independent custom notes');
    assert.deepEqual(await readFile(installed.paths.config), config);
    assert.deepEqual(await readFile(join(cwd, '.env')), env);
    assert.equal((await setup({ client, cwd }, { source, version: '0.2.3' })).status, 'unchanged');
  });
}

test('a mixed manual merge still blocks unique edits and missing managed files before writing anything', async t => {
  const { cwd, source } = await fixture(t);
  const options = { client: 'cursor', cwd };
  const installed = await setup(options, { source, version: '0.2.2' });
  await writeFile(join(source, 'SKILL.md'), 'Incoming skill');
  await writeFile(join(installed.paths.skill!, 'SKILL.md'), 'Incoming skill');
  await writeFile(join(source, 'references', 'work.md'), 'Incoming reference');
  const reference = join(installed.paths.skill!, 'references', 'work.md');
  await writeFile(reference, 'User-specific content that must survive');
  let before = await tree(cwd);
  await assert.rejects(setup(options, { source, version: '0.2.3' }), /Managed skill file/);
  assert.deepEqual(await tree(cwd), before);
  await rm(reference);
  before = await tree(cwd);
  await assert.rejects(setup(options, { source, version: '0.2.3' }), /Managed skill file/);
  assert.deepEqual(await tree(cwd), before);
  await writeFile(reference, 'Work v1');
  const config = await readFile(installed.paths.config, 'utf8');
  await writeFile(installed.paths.config, config.replace('npx', 'custom-command'));
  before = await tree(cwd);
  await assert.rejects(setup(options, { source, version: '0.2.3' }), /Managed steercards MCP fields/);
  assert.deepEqual(await tree(cwd), before);
});

test('a concurrent edit to an already-merged file is still detected by the setup baseline', async t => {
  const { cwd, source } = await fixture(t);
  const options = { client: 'cursor', cwd };
  const installed = await setup(options, { source, version: '0.2.2' });
  const skill = join(installed.paths.skill!, 'SKILL.md');
  await writeFile(join(source, 'SKILL.md'), 'Incoming skill');
  await writeFile(skill, 'Incoming skill');
  const manifest = await readFile(installed.paths.manifest), config = await readFile(installed.paths.config);
  await assert.rejects(setup(options, { source, version: '0.2.3', beforeCommit: async () => { await writeFile(skill, 'Concurrent user edit'); } }), /changed during preflight/);
  assert.equal(await readFile(skill, 'utf8'), 'Concurrent user edit');
  assert.deepEqual(await readFile(installed.paths.manifest), manifest);
  assert.deepEqual(await readFile(installed.paths.config), config);
});

test('startup accepts matching manual merges but keeps same-version and downgrade guards', async t => {
  const { cwd, source } = await fixture(t);
  const options = { client: 'cursor', cwd };
  const installed = await setup(options, { source, version: '0.2.2' });
  await writeFile(join(source, 'SKILL.md'), 'Incoming skill');
  await writeFile(join(installed.paths.skill!, 'SKILL.md'), 'Incoming skill');
  const before = await tree(cwd);
  assert.equal((await refreshManagedSetup(options, { source, version: '0.2.2' })).status, 'skipped');
  assert.equal((await refreshManagedSetup(options, { source, version: '0.2.1' })).status, 'skipped');
  assert.deepEqual(await tree(cwd), before);
  assert.equal((await refreshManagedSetup(options, { source, version: '0.2.3' })).status, 'updated');
  assert.equal(JSON.parse(await readFile(installed.paths.manifest, 'utf8')).version, '0.2.3');
});

test('a matching manual merge does not bypass read-only protection for the remaining startup update', async t => {
  const { cwd, source } = await fixture(t);
  const options = { client: 'cursor', cwd };
  const installed = await setup(options, { source, version: '0.2.2' });
  await writeFile(join(source, 'SKILL.md'), 'Incoming skill');
  await writeFile(join(installed.paths.skill!, 'SKILL.md'), 'Incoming skill');
  await writeFile(join(source, 'references', 'work.md'), 'Incoming reference');
  const reference = join(installed.paths.skill!, 'references', 'work.md');
  await chmod(reference, 0o444);
  try {
    const before = await tree(cwd);
    assert.equal((await refreshManagedSetup(options, { source, version: '0.2.3' })).status, 'blocked');
    assert.deepEqual(await tree(cwd), before);
  } finally { await chmod(reference, 0o600); }
});

for (const client of ['codex', 'claude-code', 'cursor']) {
  test(`${client}: install, reload aliases/options, upgrade, and preserve unrelated data`, async t => {
    const { cwd, source } = await fixture(t);
    const config = client === 'codex' ? join(cwd, '.codex', 'config.toml') : client === 'claude-code' ? join(cwd, '.mcp.json') : join(cwd, '.cursor', 'mcp.json');
    const oldText = client === 'codex'
      ? '# user settings\nmodel = "user-model"\n[mcp_servers.other]\ncommand = "other"\nargs = ["secret-stays-here"]\n'
      : '{\n  // user comment must survive\n  "theme": "dark",\n  "mcpServers": { "other": { "command": "other", "args": ["secret-stays-here"] } },\n}\n';
    await put(config, oldText);
    await writeFile(join(cwd, '.env'), 'STEERCARDS_AGENT_KEY=do-not-copy');
    const options = { client, cwd, local: true, mode: 'full', envFile: 'custom.env' };
    const first = await setup(options, { source, version: '1.0.0' });
    assert.equal(first.status, 'installed');
    assert.equal(first.paths.config, config);
    assert.ok(first.paths.skill);
    assert.equal(await readFile(join(first.paths.skill!, 'SKILL.md'), 'utf8'), '---\nname: steercards\ndescription: Manage Steercards\n---\nGuide v1');
    const firstTree = await tree(cwd);
    assert.equal((await setup({ client: client === 'codex' ? 'codex-app' : client, cwd }, { source, version: '1.0.0' })).status, 'unchanged');
    assert.deepEqual(await tree(cwd), firstTree);
    assert.ok(!JSON.stringify(first).includes('do-not-copy'));
    assert.ok(!await readFile(first.paths.manifest, 'utf8').then(text => text.includes('do-not-copy')));
    await put(join(first.paths.skill!, 'user-notes.md'), 'Extra skill file');
    if (client !== 'codex') {
      const text = await readFile(config, 'utf8');
      await writeFile(config, text.replace('"steercards": {', '"steercards": {\n      "timeout": 123,'));
    } else await writeFile(config, (await readFile(config, 'utf8')) + '\n# user tail\n[unrelated]\nenabled = true\n');
    await writeFile(join(source, 'SKILL.md'), 'Guide v2');
    await rm(join(source, 'references', 'work.md'));
    await writeFile(join(source, 'references', 'new.md'), 'New reference');
    const updated = await setup({ client, cwd }, { source, version: '2.0.0' });
    assert.equal(updated.status, 'updated');
    assert.equal(updated.version, '2.0.0');
    assert.equal(await readFile(join(first.paths.skill!, 'SKILL.md'), 'utf8'), 'Guide v2');
    assert.equal(await readFile(join(first.paths.skill!, 'user-notes.md'), 'utf8'), 'Extra skill file');
    await assert.rejects(lstat(join(first.paths.skill!, 'references', 'work.md')), { code: 'ENOENT' });
    const nextText = await readFile(config, 'utf8');
    const parsed = client === 'codex' ? parseToml(nextText) : parseJsonc(nextText);
    const server = (client === 'codex' ? parsed.mcp_servers : parsed.mcpServers).steercards;
    assert.equal(server.command, process.execPath);
    assert.ok(server.args.includes('full'));
    assert.ok(server.args.includes(join(cwd, 'custom.env')));
    assert.equal(client === 'codex' ? parsed.model : parsed.theme, client === 'codex' ? 'user-model' : 'dark');
    assert.ok(nextText.includes(client === 'codex' ? '# user settings' : '// user comment must survive'));
    if (client !== 'codex') assert.equal(server.timeout, 123);
    else assert.ok(nextText.includes('# user tail'));
    assert.equal(await readFile(join(cwd, '.env'), 'utf8'), 'STEERCARDS_AGENT_KEY=do-not-copy');
    assert.equal((await setup({ client, cwd }, { source, version: '2.0.0' })).status, 'unchanged');
  });
}

test('npm setup uses latest and preserves saved nonsecret options during upgrade', async t => {
  const { cwd, source } = await fixture(t);
  const first = await setup({ client: 'cursor', cwd, mode: 'full', url: 'https://steercards.app/api/mcp', envFile: 'keys.env' }, { source, version: '1.0.0' });
  let server = parseJsonc(await readFile(first.paths.config, 'utf8')).mcpServers.steercards;
  assert.ok(server.args.includes('@steercards/agent-tools@latest'));
  assert.equal(server.args[server.args.indexOf('--client') + 1], 'cursor');
  await setup({ client: 'cursor', cwd }, { source, version: '2.0.0' });
  server = parseJsonc(await readFile(first.paths.config, 'utf8')).mcpServers.steercards;
  assert.ok(server.args.includes('@steercards/agent-tools@latest'));
  assert.equal(JSON.parse(await readFile(first.paths.manifest, 'utf8')).version, '2.0.0');
  assert.ok(server.args.includes('full'));
  assert.ok(server.args.includes('https://steercards.app/api/mcp'));
  assert.ok(server.args.includes(join(cwd, 'keys.env')));
  assert.equal(server.type, 'stdio');
});

for (const client of ['codex', 'claude-code', 'cursor']) {
  test(`${client}: managed configuration and skill edits fail before any write`, async t => {
    const { cwd, source } = await fixture(t);
    const first = await setup({ client, cwd }, { source });
    const pristineConfig = await readFile(first.paths.config, 'utf8');
    await writeFile(first.paths.config, pristineConfig.replace('npx', 'user-command'));
    let baseline = await tree(cwd);
    await assert.rejects(setup({ client, cwd }, { source, version: '2.0.0' }), /Managed steercards MCP fields/);
    assert.deepEqual(await tree(cwd), baseline);
    await writeFile(first.paths.config, pristineConfig);
    await writeFile(join(first.paths.skill!, 'SKILL.md'), 'My skill edit');
    baseline = await tree(cwd);
    await assert.rejects(setup({ client, cwd }, { source, version: '2.0.0' }), /Managed skill file/);
    assert.deepEqual(await tree(cwd), baseline);
  });
}

test('TOML block edits and duplicate/malformed configs fail without writes or leaked contents', async t => {
  const { cwd, source } = await fixture(t);
  const first = await setup({ client: 'codex', cwd }, { source });
  await writeFile(first.paths.config, (await readFile(first.paths.config, 'utf8')).replace('command =', '# user comment inside block\ncommand ='));
  let baseline = await tree(cwd);
  await assert.rejects(setup({ client: 'codex', cwd }, { source }), /TOML block was edited/);
  assert.deepEqual(await tree(cwd), baseline);
  for (const [client, config, contents] of [
    ['codex', first.paths.config, 'key = "sensitive secret"\nkey = "duplicate"\n'],
    ['claude-code', join(cwd, '.mcp.json'), '{"private":"sensitive secret", "mcpServers":{}, "mcpServers":{}}'],
    ['cursor', join(cwd, '.cursor', 'mcp.json'), '{"private":"sensitive secret", invalid}'],
  ]) {
    await put(config, contents);
    baseline = await tree(cwd);
    await assert.rejects(setup({ client, cwd }, { source }), error => {
      assert.ok(!String(error).includes('sensitive secret'));
      return true;
    });
    assert.deepEqual(await tree(cwd), baseline);
  }
});

test('TOML preserves dates, inline settings, and multiline values; closed inline MCP tables fail safely', async t => {
  const { cwd, source } = await fixture(t);
  const config = join(cwd, '.codex', 'config.toml');
  const original = '# retained settings\ncreated = 2026-10-19T01:02:03Z\nlocal_date = 2026-10-19\nsettings = { retries = 3, enabled = true }\nprompt = """\nA user prompt with [mcp_servers.fake] text.\n"""\n';
  await put(config, original);
  await setup({ client: 'codex', cwd }, { source });
  assert.ok((await readFile(config, 'utf8')).startsWith(original));
  await setup({ client: 'codex', cwd, mode: 'full' }, { source, version: '2.0.0' });
  assert.ok((await readFile(config, 'utf8')).startsWith(original));
  const separate = join(cwd, 'inline-mcp-project');
  await mkdir(separate);
  await put(join(separate, '.codex', 'config.toml'), 'mcp_servers = { other = { command = "keep" } }\n');
  const baseline = await tree(separate);
  await assert.rejects(setup({ client: 'codex', cwd: separate }, { source }), /valid TOML|preserve/);
  assert.deepEqual(await tree(separate), baseline);
});

test('adopts exact legacy skill/config installations and preserves their extras', async t => {
  const { cwd, source } = await fixture(t);
  for (const client of ['codex', 'claude-code', 'cursor']) {
    const project = join(cwd, client);
    await mkdir(project);
    const directory = client === 'codex' ? '.agents' : client === 'claude-code' ? '.claude' : '.cursor';
    const skill = join(project, directory, 'skills', 'steercards');
    await put(join(skill, 'SKILL.md'), await readFile(join(source, 'SKILL.md'), 'utf8'));
    await put(join(skill, 'references', 'work.md'), 'Work v1');
    await put(join(skill, 'user.md'), 'Keep extra');
    const config = client === 'codex' ? join(project, '.codex', 'config.toml') : client === 'claude-code' ? join(project, '.mcp.json') : join(project, '.cursor', 'mcp.json');
    await put(config, clientConfig(client, { cwd: project }));
    const result = await setup({ client, cwd: project }, { source });
    assert.equal(result.status, 'installed');
    assert.equal(await readFile(join(skill, 'user.md'), 'utf8'), 'Keep extra');
    assert.equal((await setup({ client, cwd: project }, { source })).status, 'unchanged');
  }
});

test('unmanaged conflicting config and incomplete or changed skills are preserved', async t => {
  const { cwd, source } = await fixture(t);
  await put(join(cwd, '.mcp.json'), '{"mcpServers":{"steercards":{"command":"custom","args":[]}}}');
  let baseline = await tree(cwd);
  await assert.rejects(setup({ client: 'claude-code', cwd }, { source }), /unmanaged steercards MCP configuration/);
  assert.deepEqual(await tree(cwd), baseline);
  await rm(join(cwd, '.mcp.json'));
  await put(join(cwd, '.claude', 'skills', 'steercards', 'SKILL.md'), 'Custom guide');
  await put(join(cwd, '.claude', 'skills', 'steercards', 'references', 'work.md'), 'Work v1');
  baseline = await tree(cwd);
  await assert.rejects(setup({ client: 'claude-code', cwd }, { source }), /unmanaged skill file/);
  assert.deepEqual(await tree(cwd), baseline);
});

for (const platform of ['darwin', 'win32'] as const) {
  test(`Desktop ${platform}: config and deterministic ZIP update together with manual upload steps`, async t => {
    const { cwd, source, home } = await fixture(t);
    const appData = join(home, 'custom-appdata');
    const config = platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') : join(appData, 'Claude', 'claude_desktop_config.json');
    await put(config, '{\n // desktop preference\n "preference": true, "mcpServers": {"other": {"command":"keep"}}\n}\n');
    const options: SetupOptions = { client: 'claude-desktop', cwd, home, platform, env: { APPDATA: appData } };
    const first = await setup(options, { source, version: '1.0.0' });
    assert.equal(first.paths.config, config);
    assert.equal(first.paths.skillZip, join(cwd, '.steercards', 'steercards-skill.zip'));
    assert.ok(first.nextSteps.some(step => step.includes('Upload')));
    const zip = await readFile(first.paths.skillZip!);
    assert.equal(strFromU8(unzipSync(zip)['steercards/references/work.md']), 'Work v1');
    assert.equal((await setup(options, { source, version: '1.0.0' })).status, 'unchanged');
    assert.deepEqual(await readFile(first.paths.skillZip!), zip);
    await writeFile(join(source, 'SKILL.md'), 'Guide update');
    assert.equal((await setup(options, { source, version: '2.0.0' })).status, 'updated');
    assert.equal(strFromU8(unzipSync(await readFile(first.paths.skillZip!))['steercards/SKILL.md']), 'Guide update');
    const text = await readFile(config, 'utf8');
    assert.ok(text.includes('// desktop preference'));
    assert.equal(parseJsonc(text).preference, true);
    await writeFile(first.paths.skillZip!, 'User replacement ZIP');
    const before = await tree(cwd);
    await assert.rejects(setup(options, { source }), /existing skill ZIP differs/);
    assert.deepEqual(await tree(cwd), before);
  });
}

test('unsupported Desktop platform and dry run create no files or directories', async t => {
  const { root, cwd, source, home } = await fixture(t);
  let baseline = await tree(root);
  await assert.rejects(setup({ client: 'claude-desktop', cwd, home, platform: 'linux' }, { source }), /macOS and Windows/);
  assert.deepEqual(await tree(root), baseline);
  for (const client of ['codex', 'claude-code', 'cursor', 'claude-desktop']) {
    baseline = await tree(root);
    const report = await setup({ client, cwd, home, platform: 'darwin', dryRun: true }, { source });
    assert.equal(report.status, 'dry-run');
    assert.ok(report.actions.length >= 3);
    assert.deepEqual(await tree(root), baseline);
  }
});

test('ordinary failure rolls back all writes for fresh install and update', async t => {
  const { root, cwd, source } = await fixture(t);
  let baseline = await tree(root);
  const failure = { source, beforeWrite: async (_path: string, index: number) => { if (index === 2) throw new Error('injected failure'); } };
  await assert.rejects(setup({ client: 'codex', cwd }, failure), /injected failure/);
  assert.deepEqual(await tree(root), baseline);
  const installed = await setup({ client: 'codex', cwd }, { source });
  await writeFile(join(source, 'SKILL.md'), 'Updated guide');
  await writeFile(join(source, 'references', 'work.md'), 'Updated reference');
  baseline = await tree(root);
  await assert.rejects(setup({ client: 'codex', cwd }, { ...failure, version: '2.0.0' }), /injected failure/);
  assert.deepEqual(await tree(root), baseline);
  assert.ok(await readFile(installed.paths.manifest, 'utf8'));
});

test('concurrent destination edits and config locks reject without overwriting', async t => {
  const { cwd, source } = await fixture(t);
  const config = join(cwd, '.mcp.json');
  await assert.rejects(setup({ client: 'claude-code', cwd }, { source, beforeCommit: () => writeFile(config, '{"user":true}') }), /destination changed during preflight/);
  assert.equal(await readFile(config, 'utf8'), '{"user":true}');
  await assert.rejects(lstat(join(cwd, '.claude')), { code: 'ENOENT' });
  const lock = `${config}.steercards-setup.lock`;
  await writeFile(lock, 'another setup');
  const baseline = await tree(cwd);
  await assert.rejects(setup({ client: 'claude-code', cwd }, { source }), /Another setup holds/);
  assert.deepEqual(await tree(cwd), baseline);
});

test('rollback preserves an external edit made after a setup write', async t => {
  const { cwd, source } = await fixture(t);
  const config = join(cwd, '.mcp.json');
  await assert.rejects(setup({ client: 'claude-code', cwd }, {
    source,
    beforeWrite: async (_path, index) => {
      if (index === 1) {
        await writeFile(config, '{"external edit":true}');
        throw new Error('injected failure after external edit');
      }
    },
  }), /rollback could not restore every file/);
  assert.equal(await readFile(config, 'utf8'), '{"external edit":true}');
});

test('symlinks under trusted project and home bases are refused', { skip: process.platform === 'win32' }, async t => {
  const { root, cwd, source, home } = await fixture(t);
  const outside = join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(cwd, '.codex'));
  const baseline = await tree(cwd);
  await assert.rejects(setup({ client: 'codex', cwd }, { source }), /symbolic link/);
  assert.deepEqual(await tree(cwd), baseline);
  await mkdir(join(home, 'Library'));
  await symlink(outside, join(home, 'Library', 'Application Support'));
  await assert.rejects(setup({ client: 'claude-desktop', cwd, home, platform: 'darwin' }, { source }), /symbolic link/);
  assert.deepEqual(await readdir(outside), []);
});

test('setup only references env paths and never follows or reads an existing dotenv symlink', { skip: process.platform === 'win32' }, async t => {
  const { root, cwd, source } = await fixture(t);
  const untouched = join(root, 'secret-env');
  await writeFile(untouched, 'STEERCARDS_AGENT_KEY=never-read-or-copy');
  await symlink(untouched, join(cwd, '.env'));
  const result = await setup({ client: 'claude-code', cwd, envFile: '.env' }, { source });
  assert.equal(await readFile(untouched, 'utf8'), 'STEERCARDS_AGENT_KEY=never-read-or-copy');
  assert.ok((await lstat(join(cwd, '.env'))).isSymbolicLink());
  assert.ok(!JSON.stringify(result).includes('never-read-or-copy'));
  assert.ok(!(await readFile(result.paths.config, 'utf8')).includes('never-read-or-copy'));
});
