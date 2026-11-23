import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDesktopUpdater, DesktopUpdateError, TPV_DESKTOP_UPDATE_PUBLIC_KEY } from '../dist/desktop-updates.cjs';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' });
const origin = 'https://release.thepropervolume.com';
const release = Buffer.from('A synthetic verified installer.');
const sha256 = createHash('sha256').update(release).digest('hex');
const artifact = { platform: 'win32', arch: 'x64', kind: 'nsis', file: 'booth-0.11.0-windows-x64-setup.exe', bytes: release.length, sha256 };
const manifest = { format: 1, product: 'booth', version: '0.11.0', artifacts: [artifact] };

function signed(value = manifest, signer = keys.privateKey) {
  const payload = Buffer.from(JSON.stringify(value, null, 2));
  return { payload: payload.toString('base64url'), signature: sign(null, payload, signer).toString('base64url') };
}

async function fixture(t, override = {}) {
  const testDirectory = await mkdtemp(join(tmpdir(), 'tpv-update-'));
  t.after(() => rm(testDirectory, { recursive: true, force: true }));
  const cacheDirectory = join(testDirectory, 'updates');
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return url.endsWith('.json') ? Response.json(signed()) : new Response(release);
  };
  const updater = createDesktopUpdater({ product: 'booth', runningVersion: '0.10.13', platform: 'win32', arch: 'x64', publicKey, cacheDirectory, fetch, ...override });
  return { updater, calls, cacheDirectory, testDirectory };
}

const updateError = code => error => error instanceof DesktopUpdateError && error.code === code;

test('only fixed product/platform HTTPS paths are used and notify mode never downloads', async t => {
  assert.match(TPV_DESKTOP_UPDATE_PUBLIC_KEY, /^-----BEGIN PUBLIC KEY-----/);
  const { updater, calls, cacheDirectory } = await fixture(t);
  const advertised = await updater.check();
  assert.equal(advertised.status, 'available');
  assert.deepEqual(advertised.update, { product: 'booth', version: '0.11.0', artifact });
  assert.ok(Object.isFrozen(advertised.update) && Object.isFrozen(advertised.update.artifact));
  assert.deepEqual(calls.map(call => call.url), [`${origin}/booth/updates/win32-x64.json`]);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.credentials, 'omit');
  await assert.rejects(stat(cacheDirectory), { code: 'ENOENT' });
  await assert.rejects(updater.download(structuredClone(advertised.update)), updateError('manifest'));
  await assert.rejects(updater.prepareInstall(advertised.update), updateError('artifact'));
  const downloaded = await updater.download(advertised.update);
  assert.deepEqual(await readFile(downloaded.path), release);
  assert.equal(calls.at(-1).url, `${origin}/booth/v0.11.0/${artifact.file}`);
  assert.equal(calls.at(-1).init.headers['Accept-Encoding'], 'identity');
  assert.deepEqual(await updater.prepareInstall(advertised.update), downloaded);
  assert.equal(calls.length, 2);
});

test('off suppresses automatic requests and both staging modes only cache verified bytes', async t => {
  const { updater, calls } = await fixture(t, { mode: 'off' });
  assert.deepEqual(await updater.check(), { status: 'disabled' });
  assert.equal(calls.length, 0);
  assert.equal((await updater.check({ manual: true })).status, 'available');
  assert.equal(calls.length, 1);
  updater.setMode('install');
  const staged = await updater.check();
  assert.equal(staged.status, 'downloaded');
  assert.deepEqual(await readFile(staged.path), release);
  assert.equal(calls.length, 3);
  updater.setMode('download');
  assert.equal((await updater.check()).status, 'downloaded');
  assert.equal(calls.length, 4);
  await assert.rejects(updater.applyAppImageUpdate(staged.update, staged.path), updateError('installation'));
});

test('changing the preference cancels only the active automatic check', async t => {
  let start;
  const started = new Promise(resolve => { start = resolve; });
  const { updater } = await fixture(t, { fetch: (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('synthetic fetch details')), { once: true });
    start();
  }) });
  const pending = updater.check();
  await started;
  updater.setMode('off');
  await assert.rejects(pending, updateError('cancelled'));
  assert.deepEqual(await updater.check(), { status: 'disabled' });
});

test('invalid signatures, wrong products, unsafe artifact paths and ambiguous releases are refused', async t => {
  const other = generateKeyPairSync('ed25519');
  const original = signed();
  const alteredPayload = Buffer.from(JSON.stringify({ ...manifest, version: '9.9.9' })).toString('base64url');
  const invalid = [signed(manifest, other.privateKey), { ...original, payload: alteredPayload }, { ...original, signature: original.signature + '=' },
    signed({ ...manifest, product: 'studio' }), signed({ ...manifest, version: '0.11.0\n' }),
    signed({ ...manifest, artifacts: [{ ...artifact, file: '../elsewhere.exe' }] }),
    signed({ ...manifest, artifacts: [{ ...artifact, kind: 'dmg' }] }),
    signed({ ...manifest, artifacts: [artifact, { ...artifact, file: 'other.exe' }] }),
    signed({ ...manifest, artifacts: [{ ...artifact, bytes: 2 * 1024 ** 3 + 1 }] })];
  for (const body of invalid) {
    const { updater } = await fixture(t, { fetch: async () => Response.json(body) });
    await assert.rejects(updater.check(), updateError('manifest'));
  }
  const redirected = await fixture(t, { fetch: async () => Response.redirect(`${origin}/another.json`) });
  await assert.rejects(redirected.updater.check(), updateError('unavailable'));
  const large = await fixture(t, { fetch: async () => new Response('x'.repeat(65_537)) });
  await assert.rejects(large.updater.check(), updateError('manifest'));
});

test('releases are numeric, newer, and selected only for the requested architecture and kind', async t => {
  for (const version of ['0.10.9', '0.10.13']) {
    const { updater } = await fixture(t, { fetch: async () => Response.json(signed({ ...manifest, version })) });
    assert.deepEqual(await updater.check(), { status: 'current' });
  }
  const preferred = { ...artifact, file: 'windows.zip', kind: 'zip' };
  const multi = { ...manifest, artifacts: [{ ...artifact, arch: 'arm64' }, artifact, preferred] };
  const { updater } = await fixture(t, { preferredKind: 'zip', fetch: async () => Response.json(signed(multi)) });
  assert.deepEqual((await updater.check()).update.artifact, preferred);
  const wrong = await fixture(t, { fetch: async () => Response.json(signed({ ...manifest, artifacts: [{ ...artifact, arch: 'arm64' }] })) });
  assert.deepEqual(await wrong.updater.check(), { status: 'current' });
});

test('truncated, oversized and tampered transfers never leave a usable update', async t => {
  for (const bytes of [release.subarray(1), Buffer.concat([release, Buffer.from('!')]), Buffer.alloc(release.length)]) {
    const { updater, cacheDirectory } = await fixture(t, { fetch: async url => url.endsWith('.json') ? Response.json(signed()) : new Response(bytes) });
    const { update } = await updater.check();
    await assert.rejects(updater.download(update), updateError('artifact'));
    assert.deepEqual(await readdir(cacheDirectory), []);
  }
  const { updater, calls } = await fixture(t);
  const { update } = await updater.check();
  const { path } = await updater.download(update);
  await writeFile(path, Buffer.alloc(release.length));
  await assert.rejects(updater.prepareInstall(update), updateError('artifact'));
  assert.equal(calls.length, 2, 'checking a staged package for installation does not fetch');
  assert.deepEqual(await readFile((await updater.download(update)).path), release);
});

test('cache symlinks and nonprivate Unix directories fail without following the target', { skip: process.platform === 'win32' }, async t => {
  const { updater, cacheDirectory, testDirectory } = await fixture(t);
  const { update } = await updater.check();
  const outside = join(testDirectory, 'elsewhere');
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, cacheDirectory, 'dir');
  await assert.rejects(updater.download(update), updateError('cache'));
  assert.deepEqual(await readdir(outside), []);
});

test('AppImage replacement applies only to the exact running image via a sibling rename', { skip: process.platform !== 'linux' }, async t => {
  const image = { ...artifact, platform: 'linux', kind: 'appimage', file: 'booth.AppImage' };
  const { updater, testDirectory } = await fixture(t, { platform: 'linux', mode: 'download',
    fetch: async url => url.endsWith('.json') ? Response.json(signed({ ...manifest, artifacts: [image] })) : new Response(release) });
  const current = join(await realpath(testDirectory), 'current.AppImage');
  await writeFile(current, 'Previous application image', { mode: 0o750 });
  const saved = process.env.APPIMAGE;
  process.env.APPIMAGE = current;
  t.after(() => { if (saved === undefined) delete process.env.APPIMAGE; else process.env.APPIMAGE = saved; });
  const { update, path } = await updater.check();
  await assert.rejects(updater.applyAppImageUpdate(update, path), updateError('installation'));
  await updater.applyAppImageUpdate(update, current);
  assert.deepEqual(await readFile(current), release);
  assert.equal((await stat(current)).mode & 0o777, 0o750);
  assert.deepEqual(await readFile(path), release);
});
