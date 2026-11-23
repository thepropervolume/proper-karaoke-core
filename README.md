# Proper Karaoke Core

Karaoke Core is the shared TypeScript package for The Proper Volume Karaoke Booth and Studio. Its first version defines lyric cue and word timing in seconds and supports plain LRC, Enhanced LRC and SRT interchange.

Run `npm ci` and `npm pack` from a Core checkout to build the npm tarball. Published tarballs and checksums are also available from [GitHub Releases](https://github.com/thepropervolume/proper-karaoke-core/releases). The package works in a browser renderer or under Node 22 and newer.

    npm install --save-exact ./vendor/thepropervolume-karaoke-core-0.1.2.tgz

Import the shared API from the package root:

~~~ts
import { parseLrc, toSrt, type LyricLine } from '@thepropervolume/karaoke-core';

const { lines } = parseLrc('[ti:Example]\n[00:05.00]Time to sing');
const cues: LyricLine[] = lines;
const subtitles = toSrt(cues);
~~~

Both parsers accept an optional makeId callback. LRC retains timed words and uses a closing timestamp when present. SRT provides line timing. Studio project JSON and TPV kit formats belong in Studio. Catalog providers, authentication, IPC and the app interfaces belong in their respective repositories.

## Desktop updates

Import `@thepropervolume/karaoke-core/desktop-updates` from the Electron main process. The CommonJS export can also be used from ESM. Pass `product` (`booth` or `studio`), the installed release's numeric `runningVersion`, and a private application `cacheDirectory` to `createDesktopUpdater`. The published Ed25519 public key is built in. Tests can pass their own `publicKey` and `fetch`.

The updater reads the fixed product, operating-system and architecture feed at `https://release.thepropervolume.com`. It verifies the manifest signature before selecting a newer compatible release, then streams any requested package to the private cache and verifies its length and SHA-256. Package URLs are constructed from signed version and filename fields. Keep the exact returned update object in the main process and pass only its display data to the renderer.

`notify` checks for updates and returns a release for review. `download` and `install` both stage a verified package. `off` skips automatic checks while allowing an explicit `check({ manual: true })`. `download(update)` can stage a release on request. `prepareInstall(update)` rechecks the cached bytes just before the app hands the package to the OS. The caller controls prompts and when an install can begin. On Linux, `applyAppImageUpdate(update, currentAppImage)` replaces the exact running AppImage with a verified sibling file without restarting the app.

## Building and releasing

Run npm ci and npm test. npm pack builds the distributable with runtime files, TypeScript declarations, corresponding source, and license notices. Release by tagging a commit on main with the package version, such as v0.1.1. The workflow runs the tests and creates a GitHub release with the npm tarball and its SHA-256 checksum.

## Installing in Booth or Studio

Download the versioned asset from the GitHub release and verify it against SHA256SUMS.txt. On Windows use Get-FileHash -Algorithm SHA256. On Linux or macOS use sha256sum or shasum -a 256.

Put the verified tarball and checksum under vendor/ in the consuming repository. Run the pinned install shown above, then commit the tarball, package.json and package-lock.json with that app's integration changes. This lets npm ci resolve the same package from a clean checkout without registry credentials. Repeat the verification for every version upgrade.

The first integration should replace Studio's duplicate LRC and SRT adapters and timeline types. Migrate Booth's matching timing types after its parser and renderer accept the same fields. Keep app-specific format wrappers available during the migration.

## License

Karaoke Core source is available under the [Mozilla Public License 2.0](LICENSE). See [licensing and branding](LICENSING.md) for the covered source and earlier versions.
