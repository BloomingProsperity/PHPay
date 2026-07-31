#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

normalize_proxy() {
  value="${1:-}"
  [ -n "$value" ] || return 0
  case "$value" in
    http://*|https://*) ;;
    *) value="http://$value" ;;
  esac
  value=$(printf '%s' "$value" | sed \
    -e 's#://127\.0\.0\.1:#://host.docker.internal:#' \
    -e 's#://localhost:#://host.docker.internal:#' \
    -e 's#://\[::1\]:#://host.docker.internal:#')
  printf '%s' "$value"
}

detected_proxy="${PHPAY_PROXY:-${HTTPS_PROXY:-${HTTP_PROXY:-${ALL_PROXY:-}}}}"
detected_proxy=$(normalize_proxy "$detected_proxy")

if [ -n "$detected_proxy" ]; then
  PHPAY_PROXY="$detected_proxy"
  export PHPAY_PROXY
  safe_proxy=$(printf '%s' "$detected_proxy" | sed 's#://[^/@]*@#://***@#')
  printf '[PHPay] Proxy: %s\n' "$safe_proxy"
else
  unset PHPAY_PROXY 2>/dev/null || true
  printf '[PHPay] Direct connection (no host proxy detected).\n'
fi

docker info >/dev/null 2>&1 || {
  printf '[PHPay] Docker is not running.\n' >&2
  exit 1
}

docker compose up -d --build
printf '[PHPay] Ready: http://127.0.0.1:3456\n'
