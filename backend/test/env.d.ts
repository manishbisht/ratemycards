declare namespace Cloudflare {
  interface Env {
    /** Injected by vitest.config.ts, not a real Worker binding. */
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[]
  }
}
