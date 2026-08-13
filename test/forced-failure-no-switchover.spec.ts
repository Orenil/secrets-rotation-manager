import { createTestApp, TestApp, uniqueSecretName, waitUntil } from './utils/test-app';
import { StuckDependent } from './utils/dependent';

/**
 * A dependent that never confirms switchover (keeps using the original
 * credential forever) must NOT get revoked out from under it on a blind
 * timer: past the grace period, the manager should raise an alert and
 * keep the old credential alive instead.
 */
describe('forced failure: dependent never switches over', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.app.close();
  });

  it('alerts and keeps the old credential alive instead of blind-revoking', async () => {
    const secretName = uniqueSecretName('orders_stuck');
    await testApp.rotation.bootstrap(secretName);

    const originalCred = await testApp.secrets.getConnectionPayload(secretName);
    const stuck = new StuckDependent(originalCred);
    const loopPromise = stuck.runLoop(60);

    await new Promise((r) => setTimeout(r, 300));
    expect(stuck.stats.successCount).toBeGreaterThan(0);

    const rotation = await testApp.rotation.startRotation(secretName);

    // .env.test grace period is 1800ms; give real headroom past it.
    await waitUntil(
      async () => (await testApp.rotations.getById(rotation.id)).state === 'alerted',
      10000,
      150,
    );

    // Let the stuck dependent keep hammering the old role for a bit after
    // the alert to prove it really is still usable, not just not-yet-dropped.
    await new Promise((r) => setTimeout(r, 500));

    const alert = await testApp.alerts.getForRotation(rotation.id);
    const oldSecret = await testApp.secrets.getById(rotation.oldSecretId);
    const rotationRow = await testApp.rotations.getById(rotation.id);

    // eslint-disable-next-line no-console
    console.log(
      `[forced-failure] rotation ${rotation.id} state=${rotationRow.state} alert="${alert?.message}" ` +
        `stuck dependent: ${stuck.stats.successCount} ok / ${stuck.stats.failureCount} failed`,
    );

    expect(alert).not.toBeNull();
    expect(alert!.message).toContain(oldSecret.roleName);
    expect(rotationRow.state).toBe('alerted');
    expect(oldSecret.status).not.toBe('revoked');
    expect(stuck.stats.failureCount).toBe(0);

    // A brand new connection attempt with the old credential must still
    // succeed too - the role genuinely was not dropped, this isn't just a
    // stale in-memory connection still limping along.
    const freshDependent = new StuckDependent(originalCred);
    await freshDependent.tick();
    expect(freshDependent.stats.failureCount).toBe(0);
    await freshDependent.close();

    testApp.telemetry.stopMonitoring(rotation.id);
    stuck.stop();
    await loopPromise;
    await stuck.close();
  }, 20000);
});
