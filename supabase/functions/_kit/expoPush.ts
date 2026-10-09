// Vendored from @just-messin-around/expo-foundation@1.34.0 (server kit). Edit upstream, then re-vendor.
// Expo push sending with per-device results: one device's error never fails
// the others, DeviceNotRegistered is reported for pruning, and every request
// is bounded.

export type ExpoMessage = {
  to: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  categoryId?: string;
  sound?: 'default' | null;
  /** Seconds the push service keeps trying to deliver. */
  ttl?: number;
  channelId?: string;
};

export type ExpoSendResult = { to: string; ok: true; ticketId: string } | { to: string; ok: false; error: string };

const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

type Ticket = { status: 'ok' | 'error'; id?: string; message?: string; details?: { error?: string } };

/**
 * Send in chunks of 100 (Expo's limit). A failed chunk marks each of its
 * messages as an error rather than throwing. `accessToken` is needed only when
 * Expo "enhanced push security" is on.
 */
export async function sendExpoPush(
  messages: ExpoMessage[],
  opts: { timeoutMs?: number; accessToken?: string; onDeviceNotRegistered?: (token: string) => void } = {},
): Promise<ExpoSendResult[]> {
  const out: ExpoSendResult[] = [];
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const res = await fetch(SEND_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
          ...(opts.accessToken ? { Authorization: `Bearer ${opts.accessToken}` } : {}),
        },
        body: JSON.stringify(chunk.map((m) => ({ sound: 'default', ...m }))),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        for (const m of chunk) out.push({ to: m.to, ok: false, error: `HTTP ${res.status} ${text.slice(0, 200)}` });
        continue;
      }
      const tickets = ((await res.json()) as { data?: Ticket[] }).data ?? [];
      chunk.forEach((m, j) => {
        const t = tickets[j];
        if (t?.status === 'ok' && t.id) out.push({ to: m.to, ok: true, ticketId: t.id });
        else {
          const err = t?.details?.error ?? t?.message ?? 'no ticket';
          if (err === 'DeviceNotRegistered') opts.onDeviceNotRegistered?.(m.to);
          out.push({ to: m.to, ok: false, error: err });
        }
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const m of chunk) out.push({ to: m.to, ok: false, error: msg });
    }
  }
  return out;
}

export type ReceiptResult = { ticketId: string; ok: boolean; error?: string };

/** Check delivery receipts (available ~15 min after sending). Never throws. */
export async function pollReceipts(
  ticketIds: string[],
  opts: { timeoutMs?: number; accessToken?: string } = {},
): Promise<ReceiptResult[]> {
  const out: ReceiptResult[] = [];
  for (let i = 0; i < ticketIds.length; i += 300) {
    const ids = ticketIds.slice(i, i + 300);
    try {
      const res = await fetch(RECEIPTS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(opts.accessToken ? { Authorization: `Bearer ${opts.accessToken}` } : {}),
        },
        body: JSON.stringify({ ids }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
      if (!res.ok) continue;
      const data = ((await res.json()) as { data?: Record<string, Ticket> }).data ?? {};
      for (const id of ids) {
        const r = data[id];
        if (!r) continue; // not ready yet
        out.push({ ticketId: id, ok: r.status === 'ok', error: r.status === 'ok' ? undefined : r.details?.error ?? r.message });
      }
    } catch {
      // next poll retries
    }
  }
  return out;
}
