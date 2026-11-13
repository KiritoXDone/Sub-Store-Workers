import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function validateRelease(release, expectedTag = '') {
    if (release?.draft !== false || release?.prerelease !== false) {
        throw new Error('Release must be published and non-prerelease');
    }
    const tag = release?.tag_name;
    if (typeof tag !== 'string' || !tag || tag !== tag.trim() || /[\r\n\0]/.test(tag)) {
        throw new Error('Release tag is missing or invalid');
    }
    if (expectedTag && tag !== expectedTag) {
        throw new Error('Release tag does not match the requested version');
    }
    return tag;
}

export function releaseAssetUrl(release, assetName, repo) {
    const tag = validateRelease(release);
    const matches = (release.assets || []).filter((item) => item.name === assetName && item.state === 'uploaded');
    if (matches.length !== 1) throw new Error(`Release asset ${assetName} is missing or ambiguous`);
    const url = new URL(matches[0].browser_download_url);
    const expected = `/${repo}/releases/download/${tag}/${assetName}`;
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || decodeURIComponent(url.pathname) !== expected || url.search || url.hash) {
        throw new Error('Release asset URL is invalid');
    }
    return url.href;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        let text = '';
        for await (const chunk of process.stdin) text += chunk;
        const release = JSON.parse(text);
        validateRelease(release, process.argv[2] || '');
        process.stdout.write(process.argv[3] ? releaseAssetUrl(release, process.argv[3], process.argv[4]) : release.tag_name);
    } catch (error) {
        console.error(error?.message || error);
        process.exitCode = 1;
    }
}
