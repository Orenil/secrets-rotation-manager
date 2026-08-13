import { createTestApp, TestApp, uniqueSecretName, waitUntil } from './utils/test-app';
import { LiveDependent } from './utils/dependent';

/**
 * The spec's headline scenario: continuous live traffic from a real
 * dependent client, through a full rotation cycle (provision -> dual
 * overlap -> telemetry-confirmed revoke of the old Postgres role), with
 * zero failed connections.
 */
describe('live-traffic rotation', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.app.close();
  });

  it('keeps zero failed queries across provision, overlap, and revoke', async () => {
    const secretName = uniqueSecretName('orders_live');
    await testApp.rotation.bootstrap(secretName);

    const dependent = new LiveDependent(testApp.baseUrl, secretName, 300);
    const loopPromise = dependent.runLoop(40);

    // Establish baseline traffic on the original credential before rotating.
    await new Promise((r) => setTimeout(r, 400));
    expect(dependent.stats.successCount).toBeGreaterThan(0);
    expect(dependent.stats.failureCount).toBe(0);

    const rotation = await testApp.rotation.startRotation(secretName);

    await waitUntil(
      async () => (await testApp.rotations.getById(rotation.id)).state === 'revoked',
      15000,
      150,
    );

    // Keep the dependent running a bit past revoke to prove the new
    // credential keeps serving traffic uninterrupted afterwards.
    await new Promise((r) => setTimeout(r, 400));

    dependent.stop();
    await loopPromise;
    await dependent.close();

    const finalRotation = await testApp.rotations.getById(rotation.id);
    const oldSecret = await testApp.secrets.getById(rotation.oldSecretId);
    const newSecret = await testApp.secrets.getById(rotation.newSecretId);
    const alert = await testApp.alerts.getForRotation(rotation.id);

    // eslint-disable-next-line no-console
    console.log(
      `[live-traffic-rotation] queries: ${dependent.stats.successCount} ok / ${dependent.stats.failureCount} failed | ` +
        `rotation ${rotation.id}: "${oldSecret.roleName}" -> "${newSecret.roleName}" | final state: ${finalRotation.state}`,
    );

    expect(dependent.stats.failureCount).toBe(0);
    expect(dependent.stats.errors).toEqual([]);
    expect(dependent.stats.successCount).toBeGreaterThan(10);
    expect(finalRotation.state).toBe('revoked');
    expect(oldSecret.status).toBe('revoked');
    expect(newSecret.status).toBe('active');
    expect(alert).toBeNull();
  }, 30000);
});
