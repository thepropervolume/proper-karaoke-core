/** Node-only signed update discovery and verified package management. */
import { createHash, createPublicKey, randomUUID, verify, type KeyObject } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { copyFile, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const TPV_DESKTOP_UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAOC598deYVmfkzL4u4Rt76nMdxuRGdJ6RvDZC2eYmUMc=
-----END PUBLIC KEY-----`;

export type UpdateProduct = 'booth' | 'studio';
export type UpdatePlatform = 'win32' | 'linux' | 'darwin';
export type UpdateArchitecture = 'x64' | 'arm64';
export type UpdateKind = 'nsis' | 'zip' | 'appimage' | 'deb' | 'dmg' | 'pkg';
export type UpdateMode = 'notify' | 'install' | 'download' | 'off';
export type UpdateArtifact = Readonly<{ platform: UpdatePlatform; arch: UpdateArchitecture; kind: UpdateKind; file: string; bytes: number; sha256: string }>;
export type DesktopUpdate = Readonly<{ product: UpdateProduct; version: string; artifact: UpdateArtifact }>;
export type PreparedUpdate = { path: string; update: DesktopUpdate };
export type UpdateCheckResult = { status: 'disabled' | 'current' } | { status: 'available'; update: DesktopUpdate } | { status: 'downloaded' } & PreparedUpdate;

type TransferOptions = { signal?: AbortSignal };
type CheckOptions = TransferOptions & { manual?: boolean };
export type DesktopUpdaterOptions = {
  product: UpdateProduct; runningVersion: string; cacheDirectory: string; publicKey?: string;
  mode?: UpdateMode; platform?: string; arch?: string; fetch?: typeof fetch; preferredKind?: UpdateKind;
};

const ORIGIN = 'https://release.thepropervolume.com';
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 ** 3;
const SAFE_VERSION = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/;
const SAFE_FILE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/;
const HASH = /^[0-9a-f]{64}$/;
const MODES: readonly UpdateMode[] = ['notify', 'install', 'download', 'off'];
const EXTENSIONS: Readonly<Record<UpdateKind, string>> = { nsis: '.exe', zip: '.zip', appimage: '.appimage', deb: '.deb', dmg: '.dmg', pkg: '.pkg' };
const PREFERRED_KINDS: Readonly<Record<UpdatePlatform, readonly UpdateKind[]>> = { win32: ['nsis', 'zip'], linux: ['appimage', 'deb', 'zip'], darwin: ['dmg', 'pkg', 'zip'] };
const MESSAGES = {
  configuration: 'Desktop updates are unavailable for this configuration.',
  unavailable: 'The release service is unavailable. Try again later.',
  manifest: 'The update information could not be verified.',
  artifact: 'The downloaded update could not be verified.',
  cancelled: 'The update operation was cancelled.',
  cache: 'The update cache could not be read or written safely.',
  installation: 'The installed AppImage could not be replaced safely.',
} as const;

export class DesktopUpdateError extends Error {
  constructor(readonly code: keyof typeof MESSAGES) { super(MESSAGES[code]); this.name = 'DesktopUpdateError'; }
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function releaseVersion(value: unknown): value is string { return typeof value === 'string' && value.trim() === value && SAFE_VERSION.test(value); }
function platformId(value: unknown): value is UpdatePlatform { return typeof value === 'string' && Object.hasOwn(PREFERRED_KINDS, value); }
function architectureId(value: unknown): value is UpdateArchitecture { return value === 'x64' || value === 'arm64'; }
function currentOrOlder(version: string, running: string): boolean {
  const left = version.split('.').map(Number), right = running.split('.').map(Number);
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] < right[i];
  return true;
}

function manifestArtifact(value: unknown): UpdateArtifact {
  if (!exactObject(value, ['platform', 'arch', 'kind', 'file', 'bytes', 'sha256']) || !platformId(value.platform) || !architectureId(value.arch) ||
      !PREFERRED_KINDS[value.platform].includes(value.kind as UpdateKind) || typeof value.file !== 'string' || !SAFE_FILE.test(value.file) ||
      !value.file.toLowerCase().endsWith(EXTENSIONS[value.kind as UpdateKind]) || typeof value.bytes !== 'number' ||
      !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > MAX_ARTIFACT_BYTES || typeof value.sha256 !== 'string' || value.sha256.length !== 64 || !HASH.test(value.sha256))
    throw new DesktopUpdateError('manifest');
  return Object.freeze({ platform: value.platform, arch: value.arch, kind: value.kind as UpdateKind, file: value.file, bytes: value.bytes, sha256: value.sha256 });
}

function base64url(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new DesktopUpdateError('manifest');
  const raw = Buffer.from(value, 'base64url');
  if (raw.toString('base64url') !== value) throw new DesktopUpdateError('manifest');
  return raw;
}

function signedManifest(raw: Buffer, product: UpdateProduct, key: KeyObject): { version: string; artifacts: UpdateArtifact[] } {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const envelope: unknown = JSON.parse(decoder.decode(raw));
    if (!exactObject(envelope, ['payload', 'signature'])) throw new DesktopUpdateError('manifest');
    const payload = base64url(envelope.payload), signature = base64url(envelope.signature);
    if (signature.length !== 64 || !verify(null, payload, key, signature)) throw new DesktopUpdateError('manifest');
    const parsed: unknown = JSON.parse(decoder.decode(payload));
    if (!exactObject(parsed, ['format', 'product', 'version', 'artifacts']) || parsed.format !== 1 || parsed.product !== product ||
        !releaseVersion(parsed.version) || !Array.isArray(parsed.artifacts) || parsed.artifacts.length === 0 || parsed.artifacts.length > 16)
      throw new DesktopUpdateError('manifest');
    const artifacts = parsed.artifacts.map(manifestArtifact);
    const keys = new Set(artifacts.map(item => `${item.platform}-${item.arch}-${item.kind}`));
    if (keys.size !== artifacts.length) throw new DesktopUpdateError('manifest');
    return { version: parsed.version, artifacts };
  } catch { throw new DesktopUpdateError('manifest'); }
}

function checkCancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new DesktopUpdateError('cancelled'); }
function deadline(milliseconds: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function responseBody(fetcher: typeof fetch, url: string, accept: string, signal: AbortSignal, limit: number, length?: number) {
  try {
    checkCancelled(signal);
    const response = await fetcher(url, { signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { Accept: accept, ...(length === undefined ? {} : { 'Accept-Encoding': 'identity' }) } });
    if (response.status !== 200 || !response.body || response.redirected || response.url && response.url !== url) {
      void response.body?.cancel().catch(() => {});
      throw new DesktopUpdateError('unavailable');
    }
    const header = response.headers.get('content-length');
    if (header !== null && (!/^\d+$/.test(header) || Number(header) > limit || length !== undefined && Number(header) !== length) ||
        length !== undefined && !['', 'identity'].includes(response.headers.get('content-encoding')?.toLowerCase() ?? '')) {
      void response.body.cancel().catch(() => {});
      throw new DesktopUpdateError(length === undefined ? 'manifest' : 'artifact');
    }
    return response.body;
  } catch (error) {
    checkCancelled(signal);
    if (error instanceof DesktopUpdateError) throw error;
    throw new DesktopUpdateError('unavailable');
  }
}

async function consume(body: ReadableStream<Uint8Array>, signal: AbortSignal, limit: number, code: 'manifest' | 'artifact',
  handle: (chunk: Uint8Array) => void | Promise<void>): Promise<number> {
  const reader = body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      checkCancelled(signal);
      const entry = await reader.read();
      if (entry.done) break;
      bytes += entry.value.byteLength;
      if (bytes > limit) throw new DesktopUpdateError(code);
      await handle(entry.value);
    }
    checkCancelled(signal);
    return bytes;
  } catch (error) {
    checkCancelled(signal);
    if (error instanceof DesktopUpdateError) throw error;
    throw new DesktopUpdateError(code);
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type Directory = { path: string; identity: Stats };
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function sameContents(left: Stats, right: Stats): boolean {
  return sameFile(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function ownedPrivate(info: Stats): boolean {
  return typeof process.getuid !== 'function' || info.uid === process.getuid() && !(info.mode & 0o077);
}
function nonexistent(error: unknown): boolean { return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'; }

async function privateDirectory(path: string): Promise<Directory> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const identity = await lstat(path), canonical = await realpath(path);
  if (!identity.isDirectory() || !ownedPrivate(identity) || !sameFile(identity, await lstat(canonical))) throw new DesktopUpdateError('cache');
  return { path: canonical, identity };
}

async function confirmDirectory(root: Directory): Promise<void> {
  const current = await lstat(root.path);
  if (!current.isDirectory() || !ownedPrivate(current) || !sameFile(current, root.identity)) throw new DesktopUpdateError('cache');
}

async function cachedArtifact(path: string, artifact: UpdateArtifact, signal?: AbortSignal): Promise<boolean> {
  let before: Stats;
  try { before = await lstat(path); } catch (error) { if (nonexistent(error)) return false; throw error; }
  if (!before.isFile() || !ownedPrivate(before)) throw new DesktopUpdateError('cache');
  if (before.size !== artifact.bytes) return false;
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameContents(before, await file.stat())) throw new DesktopUpdateError('cache');
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(128 * 1024);
    let size = 0;
    for (;;) {
      checkCancelled(signal);
      const chunk = await file.read(buffer, 0, buffer.length, size);
      if (!chunk.bytesRead) break;
      size += chunk.bytesRead;
      if (size > artifact.bytes) return false;
      hash.update(buffer.subarray(0, chunk.bytesRead));
    }
    if (!sameContents(before, await file.stat()) || !sameContents(before, await lstat(path))) throw new DesktopUpdateError('cache');
    checkCancelled(signal);
    return size === artifact.bytes && hash.digest('hex') === artifact.sha256;
  } finally { await file.close(); }
}

/** Performs no install, launch or shutdown as part of a check, even in install mode. */
export function createDesktopUpdater(options: DesktopUpdaterOptions) {
  const { product, runningVersion, preferredKind } = options;
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch, fetcher = options.fetch ?? fetch;
  let mode = options.mode ?? 'notify';
  let key: KeyObject;
  try {
    if ((product !== 'booth' && product !== 'studio') || !releaseVersion(runningVersion) || !platformId(platform) || !architectureId(arch) ||
        !isAbsolute(options.cacheDirectory) || !MODES.includes(mode) || preferredKind !== undefined && !PREFERRED_KINDS[platform].includes(preferredKind))
      throw new DesktopUpdateError('configuration');
    const pem = options.publicKey ?? TPV_DESKTOP_UPDATE_PUBLIC_KEY;
    if (typeof pem !== 'string' || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----\s*$/.test(pem))
      throw new DesktopUpdateError('configuration');
    key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new DesktopUpdateError('configuration');
  } catch { throw new DesktopUpdateError('configuration'); }
  const authorized = new WeakSet<DesktopUpdate>();
  const automatic = new Set<AbortController>();
  const directory = resolve(options.cacheDirectory), releaseRoot = `${ORIGIN}/${product}`;

  function checkReceipt(update: DesktopUpdate): void {
    if (!authorized.has(update)) throw new DesktopUpdateError('manifest');
  }

  async function artifactPath(update: DesktopUpdate, signal?: AbortSignal): Promise<{ root: Directory; path: string }> {
    checkReceipt(update);
    checkCancelled(signal);
    const root = await privateDirectory(directory);
    const path = join(root.path, `${update.artifact.sha256.slice(0, 24)}-${update.artifact.file}`);
    return { root, path };
  }

  async function prepareInstall(update: DesktopUpdate, { signal }: TransferOptions = {}): Promise<PreparedUpdate> {
    try {
      const { root, path } = await artifactPath(update, signal);
      if (!await cachedArtifact(path, update.artifact, signal)) throw new DesktopUpdateError('artifact');
      await confirmDirectory(root);
      checkCancelled(signal);
      return { update, path };
    } catch (error) { if (error instanceof DesktopUpdateError) throw error; throw new DesktopUpdateError('cache'); }
  }

  async function download(update: DesktopUpdate, { signal }: TransferOptions = {}): Promise<PreparedUpdate> {
    let temporary: string | undefined;
    try {
      const { root, path } = await artifactPath(update, signal), artifact = update.artifact;
      if (await cachedArtifact(path, artifact, signal)) {
        await confirmDirectory(root);
        checkCancelled(signal);
        return { update, path };
      }
      const requestSignal = deadline(600_000, signal);
      const hash = createHash('sha256');
      const staging = join(root.path, `.tpv-download-${randomUUID()}.part`);
      const target = await open(staging, 'wx', 0o600);
      temporary = staging;
      try {
        const url = `${releaseRoot}/v${update.version}/${artifact.file}`;
        const body = await responseBody(fetcher, url, 'application/octet-stream', requestSignal, artifact.bytes, artifact.bytes);
        const size = await consume(body, requestSignal, artifact.bytes, 'artifact', async chunk => {
          await target.writeFile(chunk);
          hash.update(chunk);
        });
        if (size !== artifact.bytes || hash.digest('hex') !== artifact.sha256) throw new DesktopUpdateError('artifact');
        await target.sync();
      } finally { await target.close(); }
      await confirmDirectory(root);
      checkCancelled(requestSignal);
      await rename(temporary, path);
      temporary = undefined;
      return await prepareInstall(update, { signal });
    } catch (error) { if (error instanceof DesktopUpdateError) throw error; throw new DesktopUpdateError('cache'); }
    finally { if (temporary) await rm(temporary, { force: true }).catch(() => {}); }
  }

  return {
    setMode(next: UpdateMode): void {
      if (!MODES.includes(next)) throw new DesktopUpdateError('configuration');
      if (mode !== next) for (const pending of automatic) pending.abort();
      mode = next;
    },
    async check({ manual = false, signal }: CheckOptions = {}): Promise<UpdateCheckResult> {
      if (mode === 'off' && !manual) return { status: 'disabled' };
      const controller = manual ? undefined : new AbortController();
      if (controller) automatic.add(controller);
      const workSignal = controller && signal ? AbortSignal.any([controller.signal, signal]) : controller?.signal ?? signal;
      try {
        const readSignal = deadline(15_000, workSignal);
        const body = await responseBody(fetcher, `${releaseRoot}/updates/${platform}-${arch}.json`, 'application/json', readSignal, MAX_MANIFEST_BYTES);
        const chunks: Uint8Array[] = [];
        const bytes = await consume(body, readSignal, MAX_MANIFEST_BYTES, 'manifest', chunk => { chunks.push(chunk); });
        const { version, artifacts } = signedManifest(Buffer.concat(chunks, bytes), product, key);
        if (currentOrOlder(version, runningVersion)) return { status: 'current' };
        const kinds = preferredKind === undefined ? PREFERRED_KINDS[platform] : [preferredKind];
        const artifact = kinds.map(kind => artifacts.find(item => item.platform === platform && item.arch === arch && item.kind === kind)).find(item => item !== undefined);
        if (!artifact) return { status: 'current' };
        const update: DesktopUpdate = Object.freeze({ product, version, artifact });
        authorized.add(update);
        if (mode === 'download' || mode === 'install') return { status: 'downloaded', ...await download(update, { signal: workSignal }) };
        return { status: 'available', update };
      } finally { if (controller) automatic.delete(controller); }
    },
    download,
    prepareInstall,
    /** The caller owns confirmation and app lifecycle. This only replaces the running AppImage file. */
    async applyAppImageUpdate(update: DesktopUpdate, currentAppImage: string, { signal }: TransferOptions = {}): Promise<void> {
      checkReceipt(update);
      if (process.platform !== 'linux' || update.artifact.kind !== 'appimage' || currentAppImage !== process.env.APPIMAGE ||
          !isAbsolute(currentAppImage) || !currentAppImage.toLowerCase().endsWith('.appimage')) throw new DesktopUpdateError('installation');
      const prepared = await prepareInstall(update, { signal });
      let temporary: string | undefined;
      try {
        const current = await lstat(currentAppImage), parent = await lstat(dirname(currentAppImage));
        if (!current.isFile() || current.uid !== process.getuid?.() || !(current.mode & 0o100) || !parent.isDirectory() || parent.mode & 0o022 ||
            await realpath(currentAppImage) !== currentAppImage) throw new DesktopUpdateError('installation');
        const staging = join(dirname(currentAppImage), `.tpv-appimage-${randomUUID()}.part`);
        await copyFile(prepared.path, staging, constants.COPYFILE_EXCL);
        temporary = staging;
        if (!await cachedArtifact(temporary, update.artifact, signal)) throw new DesktopUpdateError('artifact');
        const file = await open(temporary, 'r+');
        try { await file.chmod(current.mode & 0o755); await file.sync(); } finally { await file.close(); }
        if (!sameContents(current, await lstat(currentAppImage)) || !sameFile(parent, await lstat(dirname(currentAppImage)))) throw new DesktopUpdateError('installation');
        checkCancelled(signal);
        await rename(temporary, currentAppImage);
        temporary = undefined;
      } catch (error) { if (error instanceof DesktopUpdateError) throw error; throw new DesktopUpdateError('installation'); }
      finally { if (temporary) await rm(temporary, { force: true }).catch(() => {}); }
    },
  };
}
