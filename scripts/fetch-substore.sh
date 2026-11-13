#!/usr/bin/env bash
set -euo pipefail

# 在本地 / GitHub Actions 中拉取/更新 Sub-Store 后端源码。
# - 默认拉取 sub-store-org/Sub-Store 的 latest release
# - 可通过环境变量覆盖：
#   - SUBSTORE_REPO=sub-store-org/Sub-Store
#   - SUBSTORE_VERSION=v2.15.0（不填则取 latest）
# - 如遇 GitHub API 限流，可提供 Token（可选）：
#   - GITHUB_TOKEN=...（Actions 默认提供）
#   - GH_TOKEN=...（兼容其他环境）
#
# 产物布局：
#   sub-store/backend  <- Sub-Store tag 源码中的 backend/

SUBSTORE_REPO="${SUBSTORE_REPO:-sub-store-org/Sub-Store}"
SUBSTORE_VERSION="${SUBSTORE_VERSION:-}"

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="${root_dir}/sub-store"
backend_dir="${work_dir}/backend"
marker_file="${work_dir}/.substore-version"

log() {
  printf '%s\n' "[fetch-substore] $*"
}

warn() {
  printf '%s\n' "[fetch-substore] 警告：$*" >&2
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[fetch-substore] 缺少依赖命令：$1" >&2
    exit 1
  }
}

require_cmd curl
require_cmd tar
require_cmd node

GITHUB_API_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

declare -a curl_auth_args
curl_auth_args=()
if [[ -n "${GITHUB_API_TOKEN}" ]]; then
  curl_auth_args+=(-H "Authorization: Bearer ${GITHUB_API_TOKEN}")
  curl_auth_args+=(-H "X-GitHub-Api-Version: 2022-11-28")
  curl_auth_args+=(-H "Accept: application/vnd.github+json")
fi

get_release_version() {
  local api="https://api.github.com/repos/${SUBSTORE_REPO}/releases/latest"
  local requested="${1:-}"
  if [[ -n "${requested}" ]]; then
    local encoded_tag
    encoded_tag="$(node -p 'encodeURIComponent(process.argv[1])' "${requested}")"
    api="https://api.github.com/repos/${SUBSTORE_REPO}/releases/tags/${encoded_tag}"
  fi
  local headers_file body_file status rc parsed
  headers_file="$(mktemp)"
  body_file="$(mktemp)"

  set +e
  status="$(
    curl -sSL --retry 3 --retry-delay 1 --retry-all-errors \
      -D "${headers_file}" -o "${body_file}" -w '%{http_code}' \
      ${curl_auth_args[@]+"${curl_auth_args[@]}"} \
      "$api"
  )"
  rc=$?
  set -e

  if [[ $rc -ne 0 ]]; then
    rm -f "${headers_file}" "${body_file}"
    echo "[fetch-substore] 获取 release 失败：网络错误（curl rc=${rc}）。" >&2
    exit 1
  fi

  if [[ "${status}" != "200" ]]; then
    if [[ "${status}" == "403" ]] && (
      grep -Eiq '^x-ratelimit-remaining:[[:space:]]*0([[:space:]]|$)' "${headers_file}" 2>/dev/null || \
      grep -Eiq 'api rate limit exceeded' "${body_file}" 2>/dev/null
    ); then
      rm -f "${headers_file}" "${body_file}"
      echo "[fetch-substore] GitHub API 已触发限流（HTTP 403）。" >&2
      echo "[fetch-substore] 解决方法：为脚本提供 Token（GITHUB_TOKEN 或 GH_TOKEN），再重试。" >&2
      exit 1
    fi

    msg="$(cat "${body_file}" 2>/dev/null || true)"
    rm -f "${headers_file}" "${body_file}"
    echo "[fetch-substore] 获取 release 失败：HTTP ${status}" >&2
    if [[ -n "${msg}" ]]; then
      echo "[fetch-substore] 响应内容：${msg}" >&2
    fi
    exit 1
  fi

  if ! parsed="$(node "${root_dir}/scripts/validate-release.mjs" "${requested}" < "${body_file}")"; then
    rm -f "${headers_file}" "${body_file}"
    echo "[fetch-substore] release 无效或不是正式发布" >&2
    return 1
  fi
  rm -f "${headers_file}" "${body_file}"
  printf '%s' "${parsed}"
}

if [[ -z "${SUBSTORE_VERSION}" ]]; then
  log "未设置 SUBSTORE_VERSION，正在解析最新 release 版本..."
fi
version="$(get_release_version "${SUBSTORE_VERSION}")"
if [[ -z "${version}" ]]; then
  echo "[fetch-substore] 解析到空版本号，终止执行" >&2
  exit 1
fi

if [[ -f "${marker_file}" ]]; then
  existing="$(cat "${marker_file}" 2>/dev/null || true)"
  if [[ "${existing}" == "${version}" ]] && [[ -f "${backend_dir}/package.json" ]]; then
    log "sub-store/backend 已是 ${version}，跳过重复下载"
    exit 0
  fi
fi

log "正在拉取 ${SUBSTORE_REPO}@${version}"

tmp="$(mktemp -d)"
moved_old=0
backup_dir="${work_dir}/backend.__old__"
new_dir="${work_dir}/backend.__new__"

on_exit() {
  # 若发生错误且已经把旧 backend 挪走，但新 backend 没落地，尽量恢复旧数据
  if [[ "${moved_old}" == "1" ]] && [[ ! -d "${backend_dir}" ]] && [[ -d "${backup_dir}" ]]; then
    warn "检测到替换失败，正在尝试恢复旧的 backend 目录..."
    rm -rf "${backend_dir}" 2>/dev/null || true
    mv "${backup_dir}" "${backend_dir}" 2>/dev/null || true
  fi

  rm -rf "${tmp}" "${new_dir}" 2>/dev/null || true
}
trap on_exit EXIT

archive="${tmp}/sub-store.tar.gz"
encoded_version="$(node -p 'encodeURIComponent(process.argv[1])' "${version}")"
curl -fL --retry 3 --retry-delay 1 --retry-all-errors \
  "https://github.com/${SUBSTORE_REPO}/archive/refs/tags/${encoded_version}.tar.gz" \
  -o "${archive}"
tar -xzf "${archive}" -C "${tmp}"

src_dir="$(find "${tmp}" -maxdepth 1 -type d -name "Sub-Store-*" | head -n 1)"
if [[ -z "${src_dir}" ]]; then
  echo "[fetch-substore] 未找到解压后的 Sub-Store 目录" >&2
  exit 1
fi

if [[ ! -d "${src_dir}/backend" ]]; then
  echo "[fetch-substore] 解压后的源码缺少 backend/：${src_dir}" >&2
  exit 1
fi

mkdir -p "${work_dir}"

# 先准备新的 backend 目录，成功后再替换（减少半成品风险）
rm -rf "${new_dir}" "${backup_dir}"

mv "${src_dir}/backend" "${new_dir}"

if [[ -d "${backend_dir}" ]]; then
  mv "${backend_dir}" "${backup_dir}"
  moved_old=1
fi
mv "${new_dir}" "${backend_dir}"
rm -rf "${backup_dir}"
moved_old=0

printf '%s' "${version}" > "${marker_file}"

log "完成：${work_dir}/backend（version=${version}）"
