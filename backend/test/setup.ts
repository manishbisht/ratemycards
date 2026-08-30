import { applyD1Migrations, env } from 'cloudflare:test'

// Setup files run outside per-file storage isolation, so every test file starts
// from the same migrated + seeded database. applyD1Migrations skips migrations
// already recorded in d1_migrations, so running it repeatedly is safe.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
