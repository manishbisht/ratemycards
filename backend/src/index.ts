import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppEnv } from './env'
import { notFound, onError } from './http/errors'
import { bankRoutes } from './modules/banks/routes'
import { cardRequestRoutes } from './modules/cardRequests/routes'
import { cardRoutes } from './modules/cards/routes'
import { networkRoutes } from './modules/networks/routes'
import { profileRoutes } from './modules/profiles/routes'
import { criterionRoutes } from './modules/scoring/routes'
import { clerkWebhookRoutes } from './modules/users/webhook'
import { handleRoutes, userRoutes } from './modules/users/routes'
import { verificationRoutes } from './modules/verification/routes'
import { walletRoutes } from './modules/wallet/routes'

/**
 * The Worker entry, and the only file that knows the module list. A new module
 * is a folder under src/modules plus one `app.route(...)` line here.
 */
const app = new Hono<AppEnv>()

// An allowlist, not '*': these endpoints accept an admin bearer token, and '*'
// would let any page on the internet drive them with a stolen token.
app.use(
  '/v1/*',
  cors({
    origin: (origin, c) => {
      const allowed = c.env.ALLOWED_ORIGINS.split(',').map((value: string) => value.trim())
      return allowed.includes(origin) ? origin : null
    },
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  }),
)

app.get('/health', (c) => c.json({ ok: true }))

app.route('/v1/banks', bankRoutes)
app.route('/v1/cards', cardRoutes)
app.route('/v1/card-requests', cardRequestRoutes)
app.route('/v1/networks', networkRoutes)
app.route('/v1/criteria', criterionRoutes)
app.route('/v1/users', userRoutes)
app.route('/v1/handles', handleRoutes)
app.route('/v1/profiles', profileRoutes)
app.route('/v1/webhooks', clerkWebhookRoutes)
app.route('/v1/wallet', walletRoutes)
app.route('/v1/verifications', verificationRoutes)

app.notFound(notFound)
app.onError(onError)

export default app
