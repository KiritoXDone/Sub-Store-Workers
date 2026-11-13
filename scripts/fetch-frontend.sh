#!/usr/bin/env bash
set -euo pipefail

FRONTEND_REPO="${FRONTEND_REPO:-sub-store-org/Sub-Store-Front-End}"
FRONTEND_VERSION="${FRONTEND_VERSION:-}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
api="https://api.github.com/repos/${FRONTEND_REPO}/releases/latest"
if [[ -n "${FRONTEND_VERSION}" ]]; then
  encoded_tag="$(node -p 'encodeURIComponent(process.argv[1])' "${FRONTEND_VERSION}")"
  api="https://api.github.com/repos/${FRONTEND_REPO}/releases/tags/${encoded_tag}"
fi

tmp="$(mktemp -d)"
target="${root_dir}/public/frontend"
backup="${tmp}/previous"
moved_old=0
cleanup() {
  if [[ "${moved_old}" == 1 && ! -d "${target}" && -d "${backup}" ]]; then
    mv "${backup}" "${target}"
  fi
  rm -rf "${tmp}"
}
trap cleanup EXIT

curl_args=(-fLsS --retry 3 --retry-delay 1 --retry-all-errors -H 'Accept: application/vnd.github+json')
if [[ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]]; then
  curl_args+=(-H "Authorization: Bearer ${GH_TOKEN:-${GITHUB_TOKEN:-}}")
fi
curl "${curl_args[@]}" "${api}" -o "${tmp}/release.json"
version="$(node "${root_dir}/scripts/validate-release.mjs" "${FRONTEND_VERSION}" < "${tmp}/release.json")"
asset_url="$(node "${root_dir}/scripts/validate-release.mjs" "${FRONTEND_VERSION}" dist.zip "${FRONTEND_REPO}" < "${tmp}/release.json")"
if [[ -f "${root_dir}/public/.frontend-version" && -f "${target}/index.html" ]] && [[ "$(cat "${root_dir}/public/.frontend-version")" == "${version}" ]]; then
  echo "[fetch-frontend] 已是正式 release ${version}"
  exit 0
fi

curl -fLsS --retry 3 --retry-delay 1 --retry-all-errors "${asset_url}" -o "${tmp}/dist.zip"
python3 - "${tmp}/dist.zip" "${tmp}/unpacked" <<'PY'
import stat, sys, zipfile
from pathlib import Path, PurePosixPath
archive, dest = sys.argv[1:]
with zipfile.ZipFile(archive) as z:
    for entry in z.infolist():
        path = PurePosixPath(entry.filename)
        if path.is_absolute() or '..' in path.parts or stat.S_ISLNK(entry.external_attr >> 16):
            raise SystemExit('Unsafe frontend archive entry')
    z.extractall(dest)
if not (Path(dest) / 'dist' / 'index.html').is_file():
    raise SystemExit('Release dist.zip is missing dist/index.html')
PY
mkdir -p "${root_dir}/public"
if [[ -d "${target}" ]]; then mv "${target}" "${backup}"; moved_old=1; fi
mv "${tmp}/unpacked/dist" "${target}"
moved_old=0
printf '%s' "${version}" > "${root_dir}/public/.frontend-version"
echo "[fetch-frontend] 完成：正式 release ${version}"
