import { Client as PgClient } from 'pg';
import { createTestApp, TestApp, uniqueSecretName, waitUntil } from './utils/test-app';

/**
 * Proves the "new role instead of in-place password change" design
 * decision actually delivers what it's supposed to: an already-open
 * connection on the old role keeps working right through rotation (it was
 * never touched), a brand-new connection on the new role works
 * immediately (no propagation delay), and only after the old role is
 * actually dropped do brand-new connection attempts with the old
 * credential start failing.
 */
describe('connection survival across a role/credential change', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.app.close();
  });

  it('never invalidates an open connection, and only rejects the old creds after confirmed revoke', async () => {
    const secretName = uniqueSecretName('orders_surv');
    await testApp.rotation.bootstrap(secretName);

    const before = await testApp.secrets.getConnectionPayload(secretName);
    const oldConn = new PgClient({
      host: before.host,
      port: before.port,
      database: before.database,
      user: before.roleName,
      password: before.password,
    });
    await oldConn.connect();
    await oldConn.query('SELECT 1');

    const rotation = await testApp.rotation.startRotation(secretName);

    // The already-open old connection must survive the role creation /
    // dual-overlap start untouched - no mid-transaction invalidation.
    const survived = await oldConn.query('SELECT 1 AS ok');
    expect(survived.rows[0].ok).toBe(1);

    // The brand-new credential must be usable immediately, with no
    // propagation delay for dependents that already picked it up.
    const after = await testApp.secrets.getConnectionPayload(secretName);
    expect(after.roleName).not.toBe(before.roleName);
    const newConn = new PgClient({
      host: after.host,
      port: after.port,
      database: after.database,
      user: after.roleName,
      password: after.password,
    });
    await newConn.connect();
    const newResult = await newConn.query('SELECT 1 AS ok');
    expect(newResult.rows[0].ok).toBe(1);

    // Close the old connection so telemetry observes zero usage and
    // confirms it's safe to revoke.
    await oldConn.end();
    await waitUntil(
      async () => (await testApp.rotations.getById(rotation.id)).state === 'revoked',
      15000,
      150,
    );

    // Only now, after confirmed revoke, does a *new* connection attempt
    // with the old role's password get rejected.
    const staleAttempt = new PgClient({
      host: before.host,
      port: before.port,
      database: before.database,
      user: before.roleName,
      password: before.password,
    });
    await expect(staleAttempt.connect()).rejects.toThrow();

    await newConn.end();
  }, 25000);
});
