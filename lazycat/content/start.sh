#!/bin/sh
set -eu
exec nginx -c /lzcapp/pkg/content/nginx.conf -g 'daemon off;'
