import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareProjectCredentials } from '../src/setup-credentials.js';

const exec = promisify(execFile);
const token = `sc_agent_${'A'.repeat(43)}`;
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'steercards-credentials-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, '한글 project with spaces');
  await mkdir(cwd);
  return { root, cwd };
}

test('credentials preserve unrelated multiline env and CRLF, override ignore negation, and rerun without exchange', async t => {
  const { cwd } = await fixture(t);
  const original = '\uFEFFOTHER="first\r\nSTEERCARDS_AGENT_KEY=inside-multiline\r\nlast"\r\nexport STEERCARDS_AGENT_KEY=  # placeholder\r\nKEEP=value';
  await writeFile(join(cwd, '.env'), original);
  const ignore = 'node_modules/\r\n.env\r\n!.env';
  await writeFile(join(cwd, '.gitignore'), ignore);
  const plan = await prepareProjectCredentials({ cwd });
  try {
    assert.equal(plan.needsExchange, true);
    await assert.rejects(plan.save(token), /Protect/);
    await plan.protect();
    await plan.save(token);
    assert.equal(await plan.readKey(), token);
    assert.equal(await readFile(join(cwd, '.env'), 'utf8'), original.replace('STEERCARDS_AGENT_KEY=  # placeholder', `STEERCARDS_AGENT_KEY=  ${token}# placeholder`));
    assert.ok((await readFile(join(cwd, '.gitignore'), 'utf8')).startsWith(ignore + '\r\n'));
    if (process.platform !== 'win32') assert.equal((await lstat(join(cwd, '.env'))).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(plan).includes(token));
  } finally { await plan.close(); }
  const before = await readFile(join(cwd, '.gitignore'));
  const next = await prepareProjectCredentials({ cwd });
  try {
    assert.equal(next.needsExchange, false);
    await next.protect();
    await assert.rejects(next.save(token), /preserved/);
    assert.deepEqual(await readFile(join(cwd, '.gitignore')), before);
  } finally { await next.close(); }
});

test('existing key is preserved unless replacement is explicit; quoted value comments survive', async t => {
  const { cwd } = await fixture(t);
  const text = "# user settings\nSTEERCARDS_AGENT_KEY='existing-key' # keep comment\nOTHER='kept'\n";
  await writeFile(join(cwd, '.env'), text);
  let plan = await prepareProjectCredentials({ cwd });
  try { assert.equal(plan.needsExchange, false); assert.equal(await plan.readKey(), 'existing-key'); await plan.protect(); }
  finally { await plan.close(); }
  assert.equal(await readFile(join(cwd, '.env'), 'utf8'), text);
  plan = await prepareProjectCredentials({ cwd, replaceAgentKey: true });
  try { await plan.protect(); await plan.save(token); }
  finally { await plan.close(); }
  assert.equal(await readFile(join(cwd, '.env'), 'utf8'), text.replace("'existing-key'", token));
});

test('malformed, duplicated and multiline key entries fail before any credential write', async t => {
  const { cwd } = await fixture(t);
  for (const text of ['STEERCARDS_AGENT_KEY=one\nexport STEERCARDS_AGENT_KEY=two\n', 'OTHER="unclosed\nSTEERCARDS_AGENT_KEY=fake\n', 'STEERCARDS_AGENT_KEY="line\nkey"\n', 'STEERCARDS_AGENT_KEY="value" garbage\n']) {
    await writeFile(join(cwd, '.env'), text);
    await assert.rejects(prepareProjectCredentials({ cwd }));
    assert.equal(await readFile(join(cwd, '.env'), 'utf8'), text);
    assert.deepEqual((await readdir(cwd)).sort(), ['.env']);
  }
});

test('project lock, destination edits and newly tracked env are detected before saving', async t => {
  const { cwd } = await fixture(t);
  const plan = await prepareProjectCredentials({ cwd });
  try {
    await assert.rejects(prepareProjectCredentials({ cwd }), /credential lock/);
    await plan.protect();
    await writeFile(join(cwd, '.env'), 'OTHER=external-edit\n');
    await assert.rejects(plan.save(token), /changed during setup/);
    assert.equal(await readFile(join(cwd, '.env'), 'utf8'), 'OTHER=external-edit\n');
  } finally { await plan.close(); }
  await exec('git', ['init', '-q', cwd]);
  await exec('git', ['-C', cwd, 'add', '-f', '.env']);
  await assert.rejects(prepareProjectCredentials({ cwd }), /tracked by Git/);
});

test('bootstrap only writes project .env and requires explicit custom-manifest transition', async t => {
  const { cwd } = await fixture(t);
  for (const envFile of ['alternate.env', '../outside.env', join(cwd, 'outside.env')]) await assert.rejects(prepareProjectCredentials({ cwd, envFile }), /project .env/);
  await assert.rejects(prepareProjectCredentials({ cwd, savedEnvFile: 'alternate.env' }), /Explicitly select/);
  const plan = await prepareProjectCredentials({ cwd, savedEnvFile: 'alternate.env', envFile: '.env', dryRun: true });
  try { assert.equal(plan.envFile, join(cwd, '.env')); assert.equal(plan.needsExchange, true); await assert.rejects(plan.protect(), /dry run/); }
  finally { await plan.close(); }
  assert.deepEqual(await readdir(cwd), []);
  await assert.rejects(prepareProjectCredentials({ cwd: join(cwd, 'missing') }), /already exist/);
});

test('default cwd and explicit dot target the current project without hydrating environment', async t => {
  const { cwd } = await fixture(t);
  const before = process.cwd();
  process.chdir(cwd);
  try {
    const implicit = await prepareProjectCredentials({ dryRun: true });
    const explicit = await prepareProjectCredentials({ cwd: '.', dryRun: true });
    assert.equal(implicit.cwd, cwd);
    assert.equal(explicit.cwd, cwd);
    await implicit.close(); await explicit.close();
    assert.deepEqual(await readdir(cwd), []);
  } finally { process.chdir(before); }
});

test('read-only environment preflight fails without changing it', async t => {
  const { cwd } = await fixture(t);
  const file = join(cwd, '.env');
  await writeFile(file, 'OTHER=keep\n');
  await chmod(file, 0o400);
  try { await assert.rejects(prepareProjectCredentials({ cwd }), /read-only/); }
  finally { await chmod(file, 0o600); }
  assert.equal(await readFile(file, 'utf8'), 'OTHER=keep\n');
});

test('credential paths refuse symlinks before writing', async t => {
  const { cwd, root } = await fixture(t);
  const target = join(root, 'external.env');
  await writeFile(target, 'OTHER=untouched\n');
  try { await symlink(target, join(cwd, '.env')); }
  catch (error) { if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Windows runner does not permit file symlinks.'); return; } throw error; }
  await assert.rejects(prepareProjectCredentials({ cwd }), /symbolic link/);
  assert.equal(await readFile(target, 'utf8'), 'OTHER=untouched\n');
});
