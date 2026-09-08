// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./db', () => ({
  getAllAgentConversations: vi.fn(),
  getAllImages: vi.fn(),
  getAllImageThumbnails: vi.fn(),
  getAllTasks: vi.fn(),
  putAgentConversation: vi.fn(),
  putImage: vi.fn(),
  putImageThumbnail: vi.fn(),
  putTask: vi.fn(),
}))
vi.mock('../store', () => ({
  getPersistedState: vi.fn(),
  useStore: { getState: vi.fn(), setState: vi.fn(), subscribe: vi.fn() },
}))

const snapshot = {
  version: 2 as const,
  updatedAt: 1,
  tasks: [],
  images: [],
  thumbnails: [],
  agentConversations: [],
  settings: {} as never,
  persistedState: null,
}

beforeEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('persistence HTTP client', () => {
  it('gets a session and sends its CSRF token before a snapshot mutation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'token-one' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { pushPersistence } = await import('./persistenceSync')

    await expect(pushPersistence(snapshot)).resolves.toBe(true)
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/persistence/session', { credentials: 'same-origin' })
    const request = fetchMock.mock.calls[1][1] as RequestInit
    expect(fetchMock.mock.calls[1][0]).toBe('/api/persistence')
    expect(request.method).toBe('PUT')
    expect(new Headers(request.headers).get('x-csrf-token')).toBe('token-one')
    expect(request.credentials).toBe('same-origin')
  })

  it('refreshes the session once after a rejected mutation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'expired' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'rejected' }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'fresh' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { requestPersistenceBackup } = await import('./persistenceSync')

    await expect(requestPersistenceBackup()).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(new Headers((fetchMock.mock.calls[3][1] as RequestInit).headers).get('x-csrf-token')).toBe('fresh')
  })

  it('rejects an empty session token without attempting a mutation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ csrfToken: '' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { requestPersistenceBackup } = await import('./persistenceSync')

    await expect(requestPersistenceBackup()).rejects.toThrow('no CSRF token')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
