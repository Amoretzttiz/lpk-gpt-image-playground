import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function read(path: string) {
  return readFileSync(path, 'utf8')
}

describe('LazyCat package configuration', () => {
  it('restricts the API proxy to the submit and polling methods', () => {
    const nginx = read('lazycat/content/nginx.conf.template')

    expect(nginx).toContain('limit_except GET POST OPTIONS')
    expect(nginx).toMatch(/limit_except GET POST OPTIONS \{\s+deny all;/)
    expect(nginx).not.toContain('limit_except POST OPTIONS')
  })

  it('uses public proxy defaults while preserving the persistence service', () => {
    const manifest = read('lzc-manifest.yml')
    const build = read('lzc-build.yml')
    const nginx = read('lazycat/content/nginx.conf.template')

    expect(manifest).toContain('API_PROXY_URL=https://api.openai.com/v1')
    expect(manifest).toContain('ENABLE_API_PROXY=false')
    expect(manifest).toContain('LOCK_API_PROXY=false')
    expect(manifest).toContain('depends_on:\n      - persistence')
    expect(manifest).toContain('persistence:\n    image:')
    expect(manifest).toContain('PERSISTENCE_DIR=/lzcapp/var/gpt-image-playground')
    expect(build).toContain('VITE_API_PROXY_AVAILABLE=__VITE_API_PROXY_AVAILABLE_PLACEHOLDER__')
    expect(build).toContain('VITE_API_PROXY_LOCKED=__VITE_API_PROXY_LOCKED_PLACEHOLDER__')
    expect(build).toContain('cp server/*.mjs lazycat/content/persistence/')
    expect(nginx).toContain('proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto')
  })
})
