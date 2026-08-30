declare namespace Cloudflare {
  interface Env {
    /** Injected by vitest.config.ts, not a real Worker binding. */
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[]
    /**
     * The private half of the throwaway keypair vitest.config.ts mints, so
     * tests can sign tokens the Worker will verify against the stub JWKS that
     * the same config serves. Serialised as a JWK, because bindings carry
     * strings.
     */
    TEST_JWT_PRIVATE_KEY: string
    /** The key id both the signed tokens and the stub JWKS carry. */
    TEST_JWT_KID: string
  }
}
