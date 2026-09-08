# GPT Image Playground — LazyCat package

This repository is packaging only. `upstream/` is the complete, unmodified source tree of official [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground) **v0.7.8**, commit `f08385c387c9efaee94df970fd408dd1ac434d33`. `UPSTREAM_COMMIT` is the immutable provenance record.

The wrapper runs the upstream production build without build-time configuration and serves the resulting static files with nginx. It does not add a backend, persistence service, provider patch, API default, proxy default, or runtime JavaScript rewrite. Features already present in the official upstream source—including its optional development/Docker API proxy support—remain part of that source; this LazyCat wrapper selects upstream's documented plain static-deployment mode.

## Versioning

Package `0.7.8-1` means upstream application v0.7.8, packaging revision 1. It intentionally sorts below the prior downstream-customized `0.7.9-5`; no nonexistent upstream v0.7.9 is claimed.

## Migration warning

This package replaces the old customized server-backed package with the official browser-only application. Data from the old custom persistence service is **not automatically imported**. Preserve the production installation and its data until you have made any backups or exports you need. Installing this review artifact is not a data migration.

## Verify and build

```sh
./scripts/verify-upstream.py
cd upstream
npm ci --include=dev
npm test
npm run build
cd ..
lzc-cli project build
```

`npm ci` and builds may create ignored files under `upstream/`; provenance verification compares every official tracked file byte-for-byte with the immutable commit. The LPK is emitted under `dist-lpk/`.
