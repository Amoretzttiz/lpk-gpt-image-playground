#!/bin/sh
# Runtime entrypoint executed inside the nginx container.
#
# /lzcapp/pkg/content/web is read-only, so we copy the static assets into a
# writable location (/srv/www) before running sed against the Vite placeholders.
# nginx then serves from /srv/www.

set -eu

# --- env defaults (mirror upstream deploy/migrate-api-env.envsh) ---
DEFAULT_API_URL=${DEFAULT_API_URL:-${API_URL:-https://api.openai.com/v1}}
API_PROXY_URL=${API_PROXY_URL:-${API_URL:-https://api.openai.com/v1}}
ENABLE_API_PROXY=${ENABLE_API_PROXY:-false}
LOCK_API_PROXY=${LOCK_API_PROXY:-false}
SHOW_PRESET_CONFIG_ONLY=${SHOW_PRESET_CONFIG_ONLY:-${SHOW_DEFAULT_CONFIG_ONLY:-false}}
LOCK_PRESET_CONFIG_PARAMS=${LOCK_PRESET_CONFIG_PARAMS:-false}
PREVENT_PRESET_CONFIG_DELETION=${PREVENT_PRESET_CONFIG_DELETION:-false}

DOCKER_LEGACY_API_URL_USED=false
if [ -n "${API_URL:-}" ]; then
    DOCKER_LEGACY_API_URL_USED=true
fi

API_PROXY_AVAILABLE=false
if [ "$ENABLE_API_PROXY" = "true" ]; then
    API_PROXY_AVAILABLE=true
fi

API_PROXY_LOCKED=false
if [ "$ENABLE_API_PROXY" = "true" ] && [ "$LOCK_API_PROXY" = "true" ]; then
    API_PROXY_LOCKED=true
fi

PRESET_CONFIG_ONLY=false
if [ "$SHOW_PRESET_CONFIG_ONLY" = "true" ]; then
    PRESET_CONFIG_ONLY=true
fi

# --- stage assets into a writable dir ---
SRC=/lzcapp/pkg/content/web
DST=/srv/www
rm -rf "$DST"
mkdir -p "$DST"
cp -a "$SRC"/. "$DST"/

# --- replace Vite placeholders baked into JS bundles ---
find "$DST/assets" -type f -name "*.js" -exec sed -i \
    -e "s|__VITE_DEFAULT_API_URL_PLACEHOLDER__|$DEFAULT_API_URL|g" \
    -e "s|__VITE_API_PROXY_AVAILABLE_PLACEHOLDER__|$API_PROXY_AVAILABLE|g" \
    -e "s|__VITE_API_PROXY_LOCKED_PLACEHOLDER__|$API_PROXY_LOCKED|g" \
    -e "s|__VITE_DOCKER_DEPLOYMENT_PLACEHOLDER__|true|g" \
    -e "s|__VITE_DOCKER_LEGACY_API_URL_USED_PLACEHOLDER__|$DOCKER_LEGACY_API_URL_USED|g" \
    -e "s|__VITE_SHOW_PRESET_CONFIG_ONLY_PLACEHOLDER__|$PRESET_CONFIG_ONLY|g" \
    -e "s|__VITE_SHOW_DEFAULT_CONFIG_ONLY_PLACEHOLDER__|$PRESET_CONFIG_ONLY|g" \
    -e "s|__VITE_LOCK_PRESET_CONFIG_PARAMS_PLACEHOLDER__|$LOCK_PRESET_CONFIG_PARAMS|g" \
    -e "s|__VITE_PREVENT_PRESET_CONFIG_DELETION_PLACEHOLDER__|$PREVENT_PRESET_CONFIG_DELETION|g" \
    {} +

# --- render nginx.conf from template (envsubst is provided by the nginx image) ---
export API_PROXY_URL
envsubst '${API_PROXY_URL}' \
    < /lzcapp/pkg/content/nginx.conf.template \
    > /etc/nginx/conf.d/default.conf

if [ "$ENABLE_API_PROXY" != "true" ]; then
    sed -i '/# BEGIN API PROXY/,/# END API PROXY/d' /etc/nginx/conf.d/default.conf
fi

echo "[start.sh] DEFAULT_API_URL=$DEFAULT_API_URL"
echo "[start.sh] API_PROXY_URL=$API_PROXY_URL"
echo "[start.sh] ENABLE_API_PROXY=$ENABLE_API_PROXY  LOCK_API_PROXY=$LOCK_API_PROXY"
echo "[start.sh] SHOW_PRESET_CONFIG_ONLY=$SHOW_PRESET_CONFIG_ONLY  LOCK_PRESET_CONFIG_PARAMS=$LOCK_PRESET_CONFIG_PARAMS  PREVENT_PRESET_CONFIG_DELETION=$PREVENT_PRESET_CONFIG_DELETION"
echo "[start.sh] Serving from $DST"

exec nginx -g 'daemon off;'
