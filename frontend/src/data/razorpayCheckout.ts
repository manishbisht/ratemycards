/**
 * Razorpay Standard Checkout, loaded on demand.
 *
 * The script is not in index.html because most visits never verify a card, and
 * it is ~100kB of third-party JavaScript that would otherwise sit on the
 * critical path of the landing screen.
 */

const SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js'

export type CheckoutSuccess = {
  razorpay_payment_id: string
  razorpay_order_id: string
  razorpay_signature: string
}

type RazorpayInstance = {
  open: () => void
  close: () => void
  on: (event: string, handler: (payload: unknown) => void) => void
}

type RazorpayConstructor = new (options: Record<string, unknown>) => RazorpayInstance

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor
  }
}

let loading: Promise<RazorpayConstructor> | null = null

/** Injected once per document; concurrent callers share the same promise. */
export function loadCheckout(): Promise<RazorpayConstructor> {
  if (window.Razorpay) return Promise.resolve(window.Razorpay)
  if (loading) return loading

  loading = new Promise<RazorpayConstructor>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT_SRC
    script.async = true
    script.onload = () => {
      if (window.Razorpay) resolve(window.Razorpay)
      else reject(new Error('Razorpay Checkout loaded but did not register itself.'))
    }
    script.onerror = () => {
      // Let the next attempt retry rather than caching the failure forever.
      loading = null
      reject(new Error('Could not load Razorpay Checkout.'))
    }
    document.head.appendChild(script)
  })

  return loading
}

export type CheckoutRequest = {
  keyId: string
  orderId: string
  amount: number
  currency: string
  /** Shown in the modal so the person knows which card they are proving. */
  cardName: string
  issuer: string
  /** 6-digit BIN prefixes for this card. Empty when none are on file. */
  iins: string[]
  /**
   * Skips Checkout's "enter your mobile number" step. We already know who this
   * is -- they are signed in -- so asking again is a step for nothing.
   */
  prefill?: { name?: string; email?: string }
}

export type CheckoutOutcome =
  | { kind: 'paid'; payload: CheckoutSuccess }
  | { kind: 'dismissed' }
  | { kind: 'failed'; reason: string }

/**
 * Opens the modal and resolves once for whichever way it ends.
 *
 * The BIN list narrows what Checkout offers — a card outside it should not be
 * accepted at the form. It is NOT the security boundary: this whole options
 * object is assembled here, in the browser, where anyone can edit it. The
 * check that decides is `POST /v1/verifications/:id/confirm`, which re-reads
 * the payment from Razorpay server-side.
 */
export function openCheckout(
  Razorpay: RazorpayConstructor,
  request: CheckoutRequest,
): Promise<CheckoutOutcome> {
  return new Promise<CheckoutOutcome>((resolve) => {
    // Whichever of handler / ondismiss / payment.failed fires first wins; the
    // others are no-ops after that.
    let settled = false
    const settle = (outcome: CheckoutOutcome) => {
      if (settled) return
      settled = true
      resolve(outcome)
    }

    const checkout = new Razorpay({
      key: request.keyId,
      order_id: request.orderId,
      amount: request.amount,
      currency: request.currency,
      name: 'Rate My Cards',
      description: `Verify ${request.issuer} ${request.cardName}`,
      prefill: {
        ...(request.prefill?.name ? { name: request.prefill.name } : {}),
        ...(request.prefill?.email ? { email: request.prefill.email } : {}),
        // Cards only, so Checkout should not offer to remember a UPI id either.
        method: 'card',
      },

      /*
       * One block, card only, restricted to this card's BINs.
       *
       * `show_default_blocks: false` is what makes it card-only: every other
       * method lives in the default blocks, and hiding them leaves just this.
       *
       * `networks` is deliberately absent. Razorpay documents `iins` with a
       * concrete format but never enumerates the accepted `networks` values --
       * and a wrong value there would match no cards at all and block payment
       * outright, where a wrong `iins` merely fails to narrow. The server-side
       * network check covers what this cannot.
       */
      config: {
        display: {
          blocks: {
            own_card: {
              name: `Your ${request.issuer} card`,
              instruments: [
                request.iins.length > 0
                  ? { method: 'card', iins: request.iins }
                  : { method: 'card' },
              ],
            },
          },
          sequence: ['block.own_card'],
          preferences: { show_default_blocks: false },
        },
      },

      handler: (payload: CheckoutSuccess) => settle({ kind: 'paid', payload }),
      modal: { ondismiss: () => settle({ kind: 'dismissed' }) },
      retry: { enabled: false },
      theme: { color: '#6366F1' },
    })

    checkout.on('payment.failed', (payload: unknown) => {
      const description = (payload as { error?: { description?: string } })?.error?.description
      settle({ kind: 'failed', reason: description ?? 'The payment was declined.' })
      checkout.close()
    })

    checkout.open()
  })
}
