// Vendored from @just-messin-around/expo-foundation@1.34.0 (server kit). Edit upstream, then re-vendor.
// Shared-secret gate for server-to-server Edge Function calls (a DB trigger, a
// pg_cron job). Supports a three-step rollout so turning it on can never cut
// off a caller you forgot: 'log' accepts and warns, 'enforce' answers 401.
//
//   1. set the secret (Edge env + Vault), mode=log, deploy
//   2. make every caller send the header; confirm "result=ok" in the logs
//   3. mode=enforce, redeploy
//
// The header value is never logged. Comparison is constant-time.

export type SecretMode = 'log' | 'enforce';
export type SecretResult = 'ok' | 'missing' | 'mismatch' | 'unconfigured';

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** Constant-time: both sides are hashed so the loop always runs over 32 bytes. */
export async function secretsEqual(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export type RequireSharedSecretOptions = {
  /** Env var holding the secret (default PUSH_SHARED_SECRET). */
  envName?: string;
  /** Env var holding the mode (default PUSH_SECRET_MODE). Unset = log; anything but log = enforce. */
  modeEnvName?: string;
  /** Header to read (default x-push-secret). */
  header?: string;
  /** Logged with the result so webhook and cron calls can be told apart. */
  label?: string;
};

/**
 * Returns null when the call may proceed, or a Response to return as-is.
 *   const denied = await requireSharedSecret(req, { label: shape }); if (denied) return denied;
 */
export async function requireSharedSecret(req: Request, opts: RequireSharedSecretOptions = {}): Promise<Response | null> {
  const expected = Deno.env.get(opts.envName ?? 'PUSH_SHARED_SECRET') ?? '';
  const rawMode = (Deno.env.get(opts.modeEnvName ?? 'PUSH_SECRET_MODE') ?? '').trim().toLowerCase();
  const mode: SecretMode = rawMode === '' || rawMode === 'log' ? 'log' : 'enforce';
  const given = req.headers.get(opts.header ?? 'x-push-secret') ?? '';
  const result: SecretResult = !expected ? 'unconfigured' : !given ? 'missing' : (await secretsEqual(given, expected)) ? 'ok' : 'mismatch';
  const tag = `[shared-secret] result=${result} mode=${mode}${opts.label ? ` shape=${opts.label}` : ''}`;
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  if (result === 'ok') {
    if (mode === 'log') console.log(tag);
    return null;
  }
  if (mode === 'log') {
    console.warn(`${tag}: accepted (log mode)`);
    return null;
  }
  if (result === 'unconfigured') {
    console.error(`${tag}: secret env var is not set`);
    return json({ error: 'Server misconfigured' }, 500);
  }
  console.warn(`${tag}: rejected`);
  return json({ error: 'Unauthorized' }, 401);
}
