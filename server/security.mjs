import { randomBytes, timingSafeEqual } from 'node:crypto'

const sessions = new Map()
const sessionTtlMs = Math.max(1, Number(process.env.SESSION_TTL_MS || 30 * 60 * 1000))
const maxSessions = Math.max(1, Number(process.env.MAX_SESSIONS || 1024))

function cleanSessions(now) {
  for (const [id, session] of sessions) {
    if (session.expiresAt > now) continue
    sessions.delete(id)
  }
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=')
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), part.slice(index + 1).trim()]
  }))
}

function sameValue(left, right) {
  const a = Buffer.from(left || '')
  const b = Buffer.from(right || '')
  return a.length === b.length && timingSafeEqual(a, b)
}

export function createSession(res) {
  const now = Date.now()
  cleanSessions(now)
  while (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value)
  const sessionId = randomBytes(32).toString('base64url')
  const csrfToken = randomBytes(32).toString('base64url')
  sessions.set(sessionId, { csrfToken, expiresAt: now + sessionTtlMs })
  res.setHeader('set-cookie', [
    'session=' + sessionId + '; Path=/; HttpOnly; SameSite=Strict',
    'csrf=' + csrfToken + '; Path=/; SameSite=Strict',
  ])
  return { csrfToken }
}

export function requireMutationSecurity(req) {
  cleanSessions(Date.now())
  const host = req.headers['x-forwarded-host'] || req.headers.host
  const protocol = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')
  if (!host || req.headers.origin !== protocol + '://' + host) return false
  const values = cookies(req)
  const expected = sessions.get(values.session)?.csrfToken
  const supplied = req.headers['x-csrf-token']
  return typeof expected === 'string' && expected.length > 0 && typeof supplied === 'string' && supplied.length > 0 && sameValue(expected, supplied) && sameValue(values.csrf, supplied)
}
