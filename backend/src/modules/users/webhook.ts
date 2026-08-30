import { verifyWebhook } from '@clerk/backend/webhooks'
import { Hono } from 'hono'
import type { UserJSON } from '@clerk/backend'
import type { AppEnv } from '../../env'
import { ApiError } from '../../http/errors'
import { deactivateUserByClerkId, upsertUserByClerkId } from './queries'
import { normalizeIdentity } from './validate'
import type { ClerkIdentity } from './userTypes'

export const clerkWebhookRoutes = new Hono<AppEnv>()

/**
 * Clerk's view of a user, flattened to what we store. The primary address is
 * picked by id rather than taking the first: the array is not ordered, and a
 * user with several addresses would otherwise get an arbitrary one.
 */
function identityFromUser(data: UserJSON): ClerkIdentity {
  const primary = data.email_addresses?.find((address) => address.id === data.primary_email_address_id)
  const name = [data.first_name, data.last_name].filter(Boolean).join(' ')

  return {
    clerkId: data.id,
    email: primary?.email_address ?? null,
    name: name.length > 0 ? name : (data.username ?? null),
    imageUrl: data.image_url ?? null,
  }
}

/**
 * Keeps the users table in step with Clerk. This is the primary path in; the
 * upsert in requireUser is the backstop for events that never arrive.
 *
 * Public by necessity -- Clerk has no session token to present -- so the
 * signature is the whole of the auth. verifyWebhook re-reads the raw request
 * body itself, which is why `c.req.raw` is handed over untouched: parsing it
 * first would leave nothing to check the signature against.
 */
clerkWebhookRoutes.post('/clerk', async (c) => {
  const signingSecret = c.env.CLERK_WEBHOOK_SIGNING_SECRET
  if (!signingSecret) {
    throw ApiError.unauthorized('Webhooks are not configured on this deployment.')
  }

  let event: Awaited<ReturnType<typeof verifyWebhook>>
  try {
    event = await verifyWebhook(c.req.raw, { signingSecret })
  } catch {
    throw ApiError.unauthorized('The webhook signature could not be verified.')
  }

  switch (event.type) {
    case 'user.created':
    case 'user.updated': {
      const identity = normalizeIdentity(identityFromUser(event.data))
      if (identity) await upsertUserByClerkId(c.env.DB, identity)
      break
    }
    case 'user.deleted': {
      // `id` is optional on the deleted payload, so it is checked rather than
      // assumed -- deactivating on `undefined` would be a silent no-op anyway.
      if (event.data.id) await deactivateUserByClerkId(c.env.DB, event.data.id)
      break
    }
    default:
      // Everything else is acknowledged rather than rejected: a 4xx would make
      // Clerk retry an event we are never going to want.
      break
  }

  return c.json({ received: true })
})
