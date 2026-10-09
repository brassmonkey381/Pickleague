// Vendored from @just-messin-around/expo-foundation@1.34.0 (server kit). Edit upstream, then re-vendor.
// A push/email outbox dispatcher for a Supabase Edge Function. Generic: the app
// passes table names, RPC names and its own resolvers. Extracted from a
// production dispatcher; the guarantees it keeps:
//
//   - The request body is never trusted for content. Only row ids are read
//     from a webhook payload; every row is re-read and CLAIMED (pending ->
//     sending) before anything is sent, so a webhook and a cron drain can never
//     send the same row at the same time.
//   - Delivery is at-least-once. Every push carries data.outboxId; device
//     action handlers dedupe on it.
//   - Rows past expires_at are marked 'expired', never sent late.
//   - Preferences, recipients' tokens and the category are resolved at send
//     time, on every retry, not frozen at enqueue.
//   - With a deliveries table, per-device results are stored and a retry sends
//     only to devices that have not succeeded yet.
//   - Bounded: no new row starts after rowStartBudgetMs; claimed rows not
//     reached are released straight back to 'pending'.
//   - Email is opt-in: nothing is emailed unless `email` is configured.
//
// Usage (supabase/functions/<name>/index.ts):
//   import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
//   import { createOutboxDispatcher } from './_kit/outboxDispatch.ts';
//   Deno.serve(createOutboxDispatcher({ supabase: createClient(url, serviceKey), ... }));
import { requireSharedSecret, type RequireSharedSecretOptions } from './auth.ts';
import { sendExpoPush, pollReceipts, type ExpoMessage } from './expoPush.ts';

// Structural subset of SupabaseClient used here, so the kit pins no version.
type Query = PromiseLike<{ data: unknown; error: { message: string } | null }> & {
  eq(col: string, v: unknown): Query;
  in(col: string, v: unknown[]): Query;
  is(col: string, v: null): Query;
  lt(col: string, v: unknown): Query;
  not(col: string, op: string, v: unknown): Query;
  limit(n: number): Query;
  select(cols?: string): Query;
  abortSignal(s: AbortSignal): Query;
};
export type ServiceClient = {
  from(table: string): {
    select(cols: string): Query;
    update(patch: Record<string, unknown>): Query;
    delete(): Query;
    upsert(rows: Record<string, unknown>[], opts?: { onConflict?: string }): Query;
  };
  rpc(fn: string, args: Record<string, unknown>): Query;
};

export type OutboxRow = {
  id: string;
  recipient_id: string;
  channel: 'push' | 'email';
  kind: string;
  title: string;
  body: string;
  deep_link: string | null;
  status: string;
  expires_at: string | null;
  [extra: string]: unknown;
};

export type OutboxDispatcherOptions = {
  supabase: ServiceClient;
  tables: {
    outbox: string;
    tokens: string;
    /** Optional per-device results table (see push_outbox.template.sql). */
    deliveries?: string;
  };
  /** Column names on the tokens table. */
  tokenColumns?: { recipient: string; token: string };
  claimRpc: string;
  releaseRpc: string;
  /** Category id for the device's button set, or undefined for a plain notification.
   *  May be async: resolved at send time, on every attempt, so it can read current state. */
  categoryFor?: (row: OutboxRow) => string | undefined | Promise<string | undefined>;
  /** Extra push data (merged under deepLink/outboxId). Content, not instructions. May be async. */
  dataFor?: (row: OutboxRow) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** False = the recipient no longer wants this; the row is closed without sending. */
  resolvePrefs?: (row: OutboxRow) => Promise<boolean>;
  /** Opt-in email channel. */
  email?: {
    resolveEmail: (row: OutboxRow) => Promise<string | null>;
    send: (to: string, row: OutboxRow) => Promise<void>;
  };
  secret?: RequireSharedSecretOptions;
  expoAccessToken?: string;
  rowStartBudgetMs?: number;
  dbTimeoutMs?: number;
  concurrency?: number;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function createOutboxDispatcher(o: OutboxDispatcherOptions): (req: Request) => Promise<Response> {
  const db = o.supabase;
  const dbMs = o.dbTimeoutMs ?? 5000;
  const budget = o.rowStartBudgetMs ?? 20_000;
  const cols = o.tokenColumns ?? { recipient: 'profile_id', token: 'token' };
  const sig = () => AbortSignal.timeout(dbMs);

  async function mark(id: string, patch: Record<string, unknown>) {
    const { error } = await db.from(o.tables.outbox).update(patch).eq('id', id).abortSignal(sig());
    if (error) console.error(`[outbox] could not mark ${id}: ${error.message}`); // reaper re-pends it
  }

  async function claimById(id: string): Promise<OutboxRow | null> {
    const { data, error } = await db
      .from(o.tables.outbox)
      .update({ status: 'sending' })
      .eq('id', id)
      .eq('status', 'pending')
      .select()
      .abortSignal(sig());
    if (error) throw new Error(error.message);
    return ((data as OutboxRow[] | null) ?? [])[0] ?? null;
  }

  async function sendPushRow(row: OutboxRow): Promise<{ ok: boolean; error?: string }> {
    const { data: tokRows, error } = await db
      .from(o.tables.tokens)
      .select(cols.token)
      .eq(cols.recipient, row.recipient_id)
      .abortSignal(sig());
    if (error) return { ok: false, error: error.message };
    let tokens = ((tokRows as Record<string, string>[] | null) ?? []).map((r) => r[cols.token]).filter(Boolean);
    if (!tokens.length) return { ok: false, error: 'No push tokens for recipient' };

    if (o.tables.deliveries) {
      const { data: done } = await db
        .from(o.tables.deliveries)
        .select('token')
        .eq('outbox_id', row.id)
        .eq('status', 'ok')
        .abortSignal(sig());
      const sent = new Set(((done as { token: string }[] | null) ?? []).map((d) => d.token));
      tokens = tokens.filter((t) => !sent.has(t));
      if (!tokens.length) return { ok: true }; // every device already has it
    }

    const ttl = row.expires_at ? Math.max(0, Math.floor((Date.parse(row.expires_at) - Date.now()) / 1000)) : undefined;
    const category = await o.categoryFor?.(row);
    const data = { ...((await o.dataFor?.(row)) ?? {}), deepLink: row.deep_link, outboxId: row.id };
    const messages: ExpoMessage[] = tokens.map((to) => ({
      to,
      title: row.title,
      body: row.body,
      data,
      ...(category ? { categoryId: category } : {}),
      ...(ttl !== undefined ? { ttl } : {}),
    }));
    const dead: string[] = [];
    const results = await sendExpoPush(messages, { accessToken: o.expoAccessToken, onDeviceNotRegistered: (t) => dead.push(t) });

    if (dead.length) {
      await db.from(o.tables.tokens).delete().in(cols.token, dead).abortSignal(sig());
    }
    if (o.tables.deliveries) {
      await db
        .from(o.tables.deliveries)
        .upsert(
          results.map((r) => ({
            outbox_id: row.id,
            token: r.to,
            status: r.ok ? 'ok' : 'error',
            ticket_id: r.ok ? r.ticketId : null,
            error: r.ok ? null : r.error,
          })),
          { onConflict: 'outbox_id,token' },
        )
        .abortSignal(sig());
    }
    const failures = results.filter((r) => !r.ok && r.error !== 'DeviceNotRegistered');
    if (failures.length) return { ok: false, error: failures.map((f) => (f.ok ? '' : f.error)).join('; ').slice(0, 500) };
    return { ok: true };
  }

  async function processRow(row: OutboxRow): Promise<void> {
    try {
      if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
        await mark(row.id, { status: 'expired' });
        return;
      }
      if (o.resolvePrefs && !(await o.resolvePrefs(row))) {
        await mark(row.id, { status: 'sent', sent_at: new Date().toISOString(), error: 'suppressed by preference' });
        return;
      }
      if (row.channel === 'email') {
        if (!o.email) {
          await mark(row.id, { status: 'failed', error: 'email channel not configured' });
          return;
        }
        const to = await o.email.resolveEmail(row);
        if (!to) {
          await mark(row.id, { status: 'failed', error: 'No deliverable email' });
          return;
        }
        await o.email.send(to, row);
        await mark(row.id, { status: 'sent', sent_at: new Date().toISOString(), error: null });
        return;
      }
      const r = await sendPushRow(row);
      if (r.ok) await mark(row.id, { status: 'sent', sent_at: new Date().toISOString(), error: null });
      else await mark(row.id, { status: 'failed', error: r.error ?? 'send failed' });
    } catch (e) {
      await mark(row.id, { status: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
  }

  return async (req: Request) => {
    const started = Date.now();
    let body: unknown = {};
    let parsedOk = true;
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text);
    } catch {
      parsedOk = false;
    }
    const shape = !parsedOk
      ? 'invalid-json'
      : Array.isArray(body)
        ? 'webhook-batch'
        : body && typeof body === 'object' && (body as { processPending?: unknown }).processPending
          ? 'processPending'
          : body && typeof body === 'object' && (body as { pollReceipts?: unknown }).pollReceipts
            ? 'pollReceipts'
          : body && typeof body === 'object' && 'record' in (body as object)
            ? 'webhook'
            : 'unknown';
    const denied = await requireSharedSecret(req, { ...o.secret, label: shape });
    if (denied) return denied;
    if (!parsedOk) return json({ error: 'Invalid JSON' }, 400);

    const rows: OutboxRow[] = [];
    let skipped = 0;
    if (shape === 'processPending') {
      const raw = (body as { limit?: unknown }).limit;
      const limit = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(1, Math.min(Math.floor(raw), 100)) : 50;
      const { data, error } = await db.rpc(o.claimRpc, { p_limit: limit }).abortSignal(sig());
      if (error) return json({ error: error.message }, 500);
      rows.push(...(((data as OutboxRow[] | null) ?? [])));
    } else if (shape === 'webhook' || shape === 'webhook-batch') {
      const items = shape === 'webhook' ? [body] : (body as unknown[]);
      const ids = [
        ...new Set(
          items
            .map((it) => (it && typeof it === 'object' ? (it as { record?: { id?: unknown } }).record?.id : null))
            .filter((id): id is string => typeof id === 'string' && UUID_RE.test(id)),
        ),
      ];
      for (const id of ids) {
        try {
          const row = await claimById(id);
          if (row) rows.push(row);
          else skipped++;
        } catch (e) {
          console.error(`[outbox] claim failed for ${id}: ${e instanceof Error ? e.message : String(e)}`);
          skipped++;
        }
      }
    }
    if (shape === 'pollReceipts') {
      if (!o.tables.deliveries) return json({ error: 'No deliveries table configured' }, 400);
      return json(await pollDeliveryReceipts(o));
    }
    if (!rows.length) return json({ processed: 0, skipped, message: 'No outbox rows to process' });

    // Bounded concurrency; nothing new starts after the budget.
    const deferred: string[] = [];
    const queue = [...rows];
    const workers = Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 4, queue.length)) }, async () => {
      for (;;) {
        const row = queue.shift();
        if (!row) return;
        if (Date.now() - started >= budget) {
          deferred.push(row.id);
          continue;
        }
        await processRow(row);
      }
    });
    await Promise.all(workers);
    if (deferred.length) {
      const { error } = await db.rpc(o.releaseRpc, { p_ids: deferred }).abortSignal(sig());
      if (error) console.error(`[outbox] release failed: ${error.message}`); // reaper covers it
    }
    return json({ processed: rows.length - deferred.length, skipped, deferred: deferred.length });
  };
}

/**
 * Check Expo receipts for deliveries sent at least 15 minutes ago (send
 * `{ pollReceipts: true }` from a cron job). A receipt error marks the
 * delivery 'error' so the next retry resends to that device;
 * DeviceNotRegistered also deletes the token. Each delivery is checked once.
 */
export async function pollDeliveryReceipts(
  o: Pick<OutboxDispatcherOptions, 'supabase' | 'tables' | 'tokenColumns' | 'expoAccessToken' | 'dbTimeoutMs'>,
  limit = 900,
): Promise<{ checked: number; failed: number; pruned: number }> {
  const db = o.supabase;
  const table = o.tables.deliveries;
  if (!table) return { checked: 0, failed: 0, pruned: 0 };
  const cols = o.tokenColumns ?? { recipient: 'profile_id', token: 'token' };
  const sig = () => AbortSignal.timeout(o.dbTimeoutMs ?? 5000);
  const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data, error } = await db
    .from(table)
    .select('outbox_id, token, ticket_id')
    .eq('status', 'ok')
    .is('receipt_checked_at', null)
    .not('ticket_id', 'is', null)
    .lt('created_at', cutoff)
    .limit(limit)
    .abortSignal(sig());
  if (error) throw new Error(error.message);
  const rows = (data as { outbox_id: string; token: string; ticket_id: string }[] | null) ?? [];
  if (!rows.length) return { checked: 0, failed: 0, pruned: 0 };
  const receipts = await pollReceipts(rows.map((r) => r.ticket_id), { accessToken: o.expoAccessToken });
  const byTicket = new Map(receipts.map((r) => [r.ticketId, r]));
  const now = new Date().toISOString();
  const dead: string[] = [];
  let failed = 0;
  const updates = rows
    .filter((r) => byTicket.has(r.ticket_id))
    .map((r) => {
      const rc = byTicket.get(r.ticket_id)!;
      if (!rc.ok) {
        failed++;
        if (rc.error === 'DeviceNotRegistered') dead.push(r.token);
      }
      return {
        outbox_id: r.outbox_id,
        token: r.token,
        ticket_id: r.ticket_id,
        status: rc.ok ? 'ok' : 'error',
        error: rc.ok ? null : rc.error ?? 'receipt error',
        receipt_checked_at: now,
      };
    });
  if (updates.length) {
    const { error: upErr } = await db.from(table).upsert(updates, { onConflict: 'outbox_id,token' }).abortSignal(sig());
    if (upErr) console.error(`[outbox] receipt update failed: ${upErr.message}`);
  }
  if (dead.length) await db.from(o.tables.tokens).delete().in(cols.token, dead).abortSignal(sig());
  return { checked: updates.length, failed, pruned: dead.length };
}
