/**
 * `Env` itself is generated into worker-configuration.d.ts by `npm run typegen`
 * -- rerun it whenever a binding is added to wrangler.jsonc. This alias is the
 * shape Hono wants, so routes can be typed `Hono<AppEnv>`.
 */
export type AppEnv = {
  Bindings: Env
}
