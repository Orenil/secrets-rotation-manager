# secrets-rotation-manager

A secrets management service that automates Postgres credential rotation
across dependent services, with a zero-downtime, dual-credential handoff
between the old and new credential.

## Problem it solves

Manual credential rotation is risky and gets skipped indefinitely, because
the naive version of automated rotation - flip the password, tell
everyone - takes every dependent service down until it redeploys with the
new value. Nobody wants to own that outage window, so the credential just
never rotates.

This project makes rotation safe enough to run routinely:

- A new credential is provisioned **alongside** the old one, both valid at
  once, for a grace period while dependents switch over on their own
  schedule.
- The old credential is only revoked once real usage telemetry - not a
  timer - confirms nothing is still connecting with it.
- A dependent that never switches over doesn't get silently cut off: it
  triggers an alert and the old credential stays alive past the intended
  window instead of being blind-revoked.

## Architecture

```
                 ┌─────────────────────────┐
                 │   NestJS control plane   │
                 │                          │
  POST /rotation/:name/start                │
  ───────────────────────────►  RotationService
                 │                  │        │
                 │      CREATE ROLE│ + GRANT │  (new Postgres role,
                 │                  ▼        │   old role untouched)
                 │            secrets table  │  (AES-256-GCM at rest)
                 │                  │        │
                 │       TelemetryService ◄──┼── polls pg_stat_activity
                 │            │      │       │   for the OLD role's
                 │   0 conns  │      │ still  │   active connections
                 │   (2x)     ▼      ▼ in use │
                 │   DROP ROLE   alerts table │  (past grace period)
                 └─────────────────────────┘
                              ▲
                   GET /secrets/:name/active
                              │
                 ┌─────────────────────────┐
                 │  RotatingSecretClient    │  short-TTL cache;
                 │  (dependent service)     │  re-fetches on expiry,
                 │                          │  no redeploy needed
                 └─────────────────────────┘
```

**Components** (`src/`):

- `crypto/encryption.service.ts` - AES-256-GCM encryption at rest for
  generated credentials, keyed by `ENCRYPTION_KEY` (Node's built-in
  `crypto`, no external KMS dependency).
- `secrets/` - the encrypted secret store: a real Postgres table
  (`secrets`) holding ciphertext + IV + auth tag per credential version,
  and the `GET /secrets/:name/active` endpoint dependents pull from.
- `rotation/rotation.service.ts` - orchestrates a rotation: creates a
  **new** Postgres role (`CREATE ROLE ... WITH LOGIN PASSWORD`, `GRANT
  app_group TO ...`) rather than mutating the existing role's password,
  marks it active, and starts telemetry monitoring on the old one.
- `rotation/telemetry.service.ts` - polls real `pg_stat_activity` for
  connections still authenticated as the old role. Two consecutive
  zero-connection readings confirm disuse and trigger `REVOKE` + `DROP
  ROLE`. If the grace period elapses with lingering connections instead,
  it writes an `alerts` row and leaves the old role alone.
- `client/rotating-secret-client.ts` - the dependent-side library:
  fetches a credential, caches it for `ttlMs`, transparently re-fetches on
  expiry, coalesces concurrent refreshes into one request.

**Data model** (`src/db/migrations.sql`): `secrets` (encrypted credential
versions + status), `rotations` (state machine: `overlapping` ->
`alerted`/`revoked`), `usage_telemetry` (every poll's connection count,
for audit), `alerts` (one row per rotation that missed its window),
`orders` (a stand-in application table dependents actually query, so the
live-traffic test is exercising real reads/writes, not a no-op ping).

### Design decisions and rejected tradeoffs

- **New role per rotation, not `ALTER ROLE ... PASSWORD`.** Changing a
  role's password in place doesn't touch already-authenticated backends,
  but it does mean there's only ever one valid credential at a time - any
  dependent connecting *after* the change and *before* it's redeployed
  gets rejected. Provisioning a brand-new role keeps two credentials
  simultaneously valid, which is the whole point of the overlap window.
  The tradeoff is role accumulation (each rotation leaves a role behind
  until it's dropped) - acceptable since revocation cleans them up as soon
  as telemetry confirms disuse.
- **Telemetry-confirmed revoke, not a timer.** A fixed "rotate after N
  minutes" timer is exactly the naive approach the spec calls out: it
  either revokes too early (breaking a slow dependent) or too late
  (leaving a stale credential valid far longer than necessary). Querying
  `pg_stat_activity` for the old role's actual connection count makes the
  revoke event-driven. The grace period still exists, but only as the
  deadline for *alerting*, never for a blind drop.
  - Rejected alternative: have dependents call an explicit "I've switched
    over" confirmation endpoint. This would need every dependent to
    implement a callback, and it can't detect a dependent that silently
    dies with an open connection. Reading real connection state directly
    from Postgres needs no cooperation from the dependent and can't be
    spoofed by one that just claims to have switched.
- **Two consecutive zero-reads before revoke**, not one. A single
  zero-connection poll could be a coincidental gap between a dependent's
  reconnects rather than genuine disuse. Requiring confirmation across two
  poll cycles (`rotation.consecutive_zero_checks`) trades a small amount
  of extra latency before revoke for protection against a false-positive
  drop.
- **Postgres-backed encrypted store over HashiCorp Vault.** Vault is the
  documented production swap - its dynamic-secrets engine could replace
  `SecretsService` almost transparently, since `RotatingSecretClient`
  already treats "fetch a short-lived credential from a service" as the
  contract, just like a Vault lease. For a self-contained portfolio
  project, standing up Vault would add an entire second system to operate
  for marginal benefit over table-level AES-256-GCM with a real key.
- **Raw `pg` over an ORM.** `CREATE ROLE` / `GRANT` / `REVOKE` / `DROP
  ROLE` and reading `pg_stat_activity` are DDL/introspection, not the kind
  of thing an ORM's query builder helps with. Using `pg` directly for
  everything (including the control-plane tables) keeps one query style
  throughout instead of mixing an ORM for CRUD with raw SQL for the parts
  that actually matter.
- **Python/FastAPI (original spec) → TypeScript/NestJS.** The rotation
  logic - dual-credential overlap, telemetry-driven revoke, alerting - is
  language-agnostic; nothing about it depends on Python. NestJS's module/
  DI system maps cleanly onto the natural component boundaries here
  (`SecretsService`, `RotationService`, `TelemetryService`, `AlertsService`
  as separately-testable providers), and Node's built-in `crypto` and the
  `pg` driver cover everything the spec asks for without extra
  dependencies.

## Setup (from a clean clone)

Requires Node 18+ and local Postgres binaries (`initdb`, `pg_ctl`, `psql`)
on your `PATH` - e.g. `brew install postgresql@14`.

```bash
npm install

# Stands up an isolated local Postgres cluster in ./.pgdata on port 5544
# (its own data dir, trust auth, does not touch any system Postgres
# install) and runs migrations.
npm run db:setup

cp .env.example .env
# generate a real key and put it in .env:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

npm run build
npm start
# secrets-rotation-manager listening on :3000
```

Stop the local cluster when you're done: `npm run db:stop`.

## Usage example (real output)

```
$ curl -s -X POST http://127.0.0.1:3099/rotation/orders_db/bootstrap
{"ok":true}

$ curl -s http://127.0.0.1:3099/secrets/orders_db/active
{
    "secretName": "orders_db",
    "roleName": "orders_db_1786613615499_6c7fe6",
    "password": "GBMVuiOg_rUlbUuGU8wxzbeecZrQNbxS",
    "host": "127.0.0.1",
    "port": 5544,
    "database": "rotation_manager",
    "status": "active"
}

$ curl -s -X POST http://127.0.0.1:3099/rotation/orders_db/start
{
    "id": 4,
    "secretName": "orders_db",
    "oldSecretId": 7,
    "newSecretId": 8,
    "state": "overlapping",
    "gracePeriodEndsAt": "2026-08-13T09:33:41.616Z",
    "consecutiveZeroChecks": 0,
    "createdAt": "2026-08-13T09:33:35.616Z",
    "completedAt": null
}

$ sleep 1 && curl -s http://127.0.0.1:3099/rotation/orders_db/status
{
    "rotation": {
        "id": 4,
        "state": "revoked",
        "consecutiveZeroChecks": 2,
        "completedAt": "2026-08-13T09:33:36.632Z",
        ...
    },
    "alert": null
}
```

No dependent was even connected in this example, so telemetry confirmed
zero usage of the old role on the very first poll cycles and revoked it
within about a second - the "live-traffic" test below does the same thing
with continuous real traffic in flight throughout.

A dependent service uses the client library instead of a baked-in
connection string:

```ts
import { RotatingSecretClient } from './src/client/rotating-secret-client';

const secret = new RotatingSecretClient({
  apiBaseUrl: 'http://rotation-manager.internal:3000',
  secretName: 'orders_db',
  ttlMs: 5000, // re-checks for a rotated credential at most every 5s
});

const cred = await secret.getCredential();
// { roleName, password, host, port, database, status }
```

## Testing

```bash
npm run db:setup   # if not already running
npm test
```

Real run against the local cluster:

```
PASS test/client-ttl-cache.spec.ts
PASS test/live-traffic-rotation.spec.ts
  ● Console
    [live-traffic-rotation] queries: 38 ok / 0 failed | rotation 1:
    "orders_live_..._eacce0" -> "orders_live_..._986cba" | final state: revoked
PASS test/forced-failure-no-switchover.spec.ts
  ● Console
    [forced-failure] rotation 2 state=alerted alert="Dependent(s) still using
    role "orders_stuck_..._c0bfb0" for secret "orders_stuck_..." (1 active
    connection(s)) past the grace period that ended 2026-08-13T09:33:01.659Z.
    Refusing a blind timer-based revoke - keeping the old credential alive
    until telemetry shows it is actually unused." stuck dependent: 47 ok / 0 failed
PASS test/connection-survival.spec.ts

Test Suites: 4 passed, 4 total
Tests:       7 passed, 7 total
Time:        7.594 s
```

- **`live-traffic-rotation.spec.ts`** - a real dependent runs continuous
  `INSERT`s against real Postgres via `RotatingSecretClient` through an
  entire rotation cycle (provision → dual overlap → telemetry-confirmed
  revoke). Asserts zero failed queries throughout.
- **`forced-failure-no-switchover.spec.ts`** - a dependent that never
  refreshes its cached credential, simulating one that never confirms
  switchover. Asserts the grace period expiry produces an `alerts` row
  (not a `DROP ROLE`), the old role's status never becomes `revoked`, and
  a brand-new connection with the old credential still succeeds.
- **`connection-survival.spec.ts`** - asserts an already-open connection
  on the old role keeps working through role creation and the overlap
  window untouched, a new connection on the new role works immediately,
  and only a genuinely-revoked old role starts rejecting new connection
  attempts.
- **`client-ttl-cache.spec.ts`** - unit tests for `RotatingSecretClient`'s
  TTL expiry/refresh, in-flight request coalescing, and manual
  invalidation.

## What's out of scope

- HashiCorp Vault integration itself (documented above as the production
  swap for the encrypted store / admin credential, not implemented).
- Rotation for anything other than Postgres roles (the spec's "For
  Postgres specifically..." requirement is the one implemented; MySQL/API
  keys would follow the same `RotationService` shape but aren't included).
- Auth/authorization on the control-plane HTTP API itself - in production
  this would sit behind mTLS or a service-mesh identity, not be open to
  any caller.
