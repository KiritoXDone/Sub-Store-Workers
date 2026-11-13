import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { releaseAssetUrl, validateRelease } from './validate-release.mjs';

test('latest and specified versions require a published, non-prerelease GitHub release', () => {
    const stable = { tag_name: '2.44.9', draft: false, prerelease: false };
    assert.equal(validateRelease(stable), '2.44.9');
    const repo = 'sub-store-org/Sub-Store-Front-End';
    const assetUrl = `https://github.com/${repo}/releases/download/${stable.tag_name}/dist.zip`;
    const withAsset = { ...stable, assets: [{ name: 'dist.zip', state: 'uploaded', browser_download_url: assetUrl }] };
    assert.equal(releaseAssetUrl(withAsset, 'dist.zip', repo), assetUrl);
    assert.throws(() => releaseAssetUrl(stable, 'dist.zip', repo));
    assert.throws(() => releaseAssetUrl({ ...withAsset, assets: [{ ...withAsset.assets[0], browser_download_url: 'https://example.test/dist.zip' }] }, 'dist.zip', repo));
    const root = mkdtempSync(path.join(os.tmpdir(), 'substore-release-'));
    try {
        mkdirSync(path.join(root, 'scripts'));
        mkdirSync(path.join(root, 'bin'));
        mkdirSync(path.join(root, 'sub-store/backend'), { recursive: true });
        for (const name of ['fetch-substore.sh', 'validate-release.mjs']) {
            cpSync(fileURLToPath(new URL(name, import.meta.url)), path.join(root, 'scripts', name));
        }
        writeFileSync(path.join(root, 'sub-store/.substore-version'), stable.tag_name);
        writeFileSync(path.join(root, 'sub-store/backend/package.json'), '{}');
        writeFileSync(path.join(root, 'bin/curl'), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    -D) headers="$2"; shift 2 ;;
    -o) body="$2"; shift 2 ;;
    -w|-H|--retry|--retry-delay) shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' "$RELEASE_FIXTURE" > "$body"
printf 'HTTP/1.1 200 OK\\n' > "$headers"
printf 200
`, { mode: 0o755 });
        const run = (release, version = '') => spawnSync('bash', [path.join(root, 'scripts/fetch-substore.sh')], {
            encoding: 'utf8',
            env: {
                PATH: `${path.join(root, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
                SUBSTORE_VERSION: version,
                RELEASE_FIXTURE: JSON.stringify(release),
            },
        });
        const latest = run(stable);
        assert.equal(latest.status, 0, latest.stderr);
        const specified = run(stable, stable.tag_name);
        assert.equal(specified.status, 0, specified.stderr);
        for (const release of [{ ...stable, draft: true }, { ...stable, prerelease: true }, { tag_name: stable.tag_name }]) {
            assert.throws(() => validateRelease(release));
            assert.notEqual(run(release).status, 0);
            assert.notEqual(run(release, stable.tag_name).status, 0);
        }
        assert.notEqual(run(stable, 'different').status, 0);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
