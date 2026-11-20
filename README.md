# Proper Karaoke Core

Karaoke Core is the shared TypeScript package for The Proper Volume Karaoke Booth and Studio. Its first version defines lyric cue and word timing in seconds and supports plain LRC, Enhanced LRC and SRT interchange.

Install the pinned package from GitHub Packages and use it in the browser renderer or under Node 22 and newer.

    npm install --save-exact @thepropervolume/karaoke-core@0.1.0

Import the shared API from the package root:

~~~ts
import { parseLrc, toSrt, type LyricLine } from '@thepropervolume/karaoke-core';

const { lines } = parseLrc('[ti:Example]\n[00:05.00]Time to sing');
const cues: LyricLine[] = lines;
const subtitles = toSrt(cues);
~~~

Both parsers accept an optional makeId callback. LRC retains timed words and uses a closing timestamp when present. SRT provides line timing. Studio project JSON and TPV kit formats belong in Studio. Catalog providers, authentication, IPC and the app interfaces belong in their respective repositories.

## Building and releasing

Run npm ci and npm test. npm pack builds the distributable with runtime files and TypeScript declarations. Release by tagging a commit on main with the package version, such as v0.1.0. The workflow runs the tests and publishes to the private GitHub npm registry.

## Private package access

Configure the @thepropervolume npm scope for GitHub Packages in both apps. For local installs, authenticate with a personal access token that has read:packages and package read access. Never commit tokens or include them in lockfile URLs.

~~~ini
@thepropervolume:registry=https://npm.pkg.github.com
~~~

In the package settings, grant GitHub Actions read access to proper-karaoke-booth and proper-karaoke-studio. Give each consuming workflow packages: read and contents: read, configure setup-node with the GitHub Packages registry for the scope, and pass its GITHUB_TOKEN as NODE_AUTH_TOKEN during npm ci. Verify a fresh install and the app's production build in each repository before switching imports.

The first integration should replace Studio's duplicate LRC and SRT adapters and timeline types. Migrate Booth's matching timing types after its parser and renderer accept the same fields. Keep app-specific format wrappers available during the migration.

See the [GitHub npm registry setup](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry) and [package access settings](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).
