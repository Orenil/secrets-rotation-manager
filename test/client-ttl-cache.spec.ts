import { RotatingSecretClient, SecretConnectionPayload } from '../src/client/rotating-secret-client';

function payload(roleName: string): SecretConnectionPayload {
  return {
    secretName: 'x',
    roleName,
    password: 'pw',
    host: 'h',
    port: 1,
    database: 'd',
    status: 'active',
  };
}

describe('RotatingSecretClient TTL cache', () => {
  it('serves the cached credential until the TTL expires, then refetches', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify(payload(`role_${calls}`)), { status: 200 }) as unknown as Response;
    }) as unknown as typeof fetch;

    const client = new RotatingSecretClient({
      apiBaseUrl: 'http://test',
      secretName: 'x',
      ttlMs: 150,
      fetchImpl,
    });

    const first = await client.getCredential();
    const second = await client.getCredential();
    expect(first.roleName).toBe('role_1');
    expect(second.roleName).toBe('role_1');
    expect(calls).toBe(1);

    await new Promise((r) => setTimeout(r, 200));

    const third = await client.getCredential();
    expect(third.roleName).toBe('role_2');
    expect(calls).toBe(2);
  });

  it('coalesces concurrent refreshes into a single in-flight fetch', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 50));
      return new Response(JSON.stringify(payload('role_x')), { status: 200 }) as unknown as Response;
    }) as unknown as typeof fetch;

    const client = new RotatingSecretClient({
      apiBaseUrl: 'http://test',
      secretName: 'x',
      ttlMs: 1000,
      fetchImpl,
    });

    const [a, b, c] = await Promise.all([
      client.getCredential(),
      client.getCredential(),
      client.getCredential(),
    ]);

    expect(calls).toBe(1);
    expect([a.roleName, b.roleName, c.roleName]).toEqual(['role_x', 'role_x', 'role_x']);
  });

  it('invalidate() forces the next call to bypass the cache', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify(payload(`role_${calls}`)), { status: 200 }) as unknown as Response;
    }) as unknown as typeof fetch;

    const client = new RotatingSecretClient({
      apiBaseUrl: 'http://test',
      secretName: 'x',
      ttlMs: 60000,
      fetchImpl,
    });

    await client.getCredential();
    client.invalidate();
    const second = await client.getCredential();

    expect(calls).toBe(2);
    expect(second.roleName).toBe('role_2');
  });

  it('surfaces HTTP errors from the API instead of caching them', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 }) as unknown as Response) as unknown as typeof fetch;
    const client = new RotatingSecretClient({ apiBaseUrl: 'http://test', secretName: 'missing', fetchImpl });

    await expect(client.getCredential()).rejects.toThrow(/404/);
  });
});
