# Background queues

The API uses BullMQ on top of Redis for three background queues:

| Queue | Trigger | Worker concurrency | Per-job attempts | Backoff base | What happens on terminal failure |
|---|---|---|---|---|---|
| `sheets-write` | Writes to `/api/v1/:apiId` (POST/PATCH/DELETE) | 3 (rate-limited 4/s) | 5 | 2s exponential (2 → 32s) | Job moved to failed list, retained 5000 deep. Webhook with `event:"row.*"` was already fired only after success, so consumers see no data. |
| `webhook-delivery` | Successful sheet writes fan out events to subscribers | 5 | 5 | 10s exponential (10 → 160s) | `WebhookDelivery.status = 'failed'`; subscription record stays active. Inspect/manual replay via the dashboard. |
| `scheduled-sync` | Cron defined per SheetApi (`syncCron`) | 2 | 3 | 5s exponential (5 → 20s) | Job dropped from active set; next cron fire re-tries the invalidation. |

Defaults live in `packages/api/src/lib/queue-options.ts` (`DEFAULT_JOB_OPTIONS`). Per-queue overrides are inlined where they apply with the reason next to them.

## Why these specific overrides

- **sheets-write** keeps a deeper failed-job trail (5000) than the default 1000 because writes touch user data — when something goes wrong we want enough history to replay or diff against snapshots, even at the cost of Redis memory.
- **webhook-delivery** uses a 10s base backoff instead of 2s. Third-party webhook targets are commonly down for >1 minute during their own incidents; aggressive retries amplify the spike without changing the outcome.
- **scheduled-sync** uses 3 attempts instead of 5. Sync is repeatable — the next cron fire will re-run the invalidation. Burning 5 retries per cron fire just delays the next fresh attempt.

## Logging

All workers log via structured pino (`packages/api/src/lib/logger.ts`) with a `component` tag (`worker:sheets-write`, `worker:webhook-delivery`, `worker:scheduled-sync`). To filter in production:

```
level:50 component:"worker:sheets-write"          # errors from sheets-write
component:"worker:webhook-delivery" subscriptionId:"<id>"   # one subscription
```

Workers never use `console.*` — that bypasses the JSON stream and breaks filtering.

## What's not here

- **Dead-letter queue.** Failed jobs sit in BullMQ's `failed` list for `removeOnFail.count` retentions, then get GC'd. There is no explicit DLQ. For incident replay we manually re-enqueue from the BullMQ failed list (use BullBoard or `redis-cli`).
- **BullBoard dashboard.** Not mounted. Tracked in issue #68 follow-ups; the auth wiring is the blocker.
- **Per-queue metrics endpoint.** Not exposed. Use Redis directly (`KEYS bull:*`) or BullMQ's Queue API for one-off inspection.

## Manual replay

To re-run a failed sheets-write job (e.g. after fixing a Google quota issue):

```bash
# In a Node REPL with the API's env loaded:
import { getSheetsWriteQueue } from './packages/api/src/queues/sheets-write.queue.js';
const q = getSheetsWriteQueue();
const failed = await q.getFailed(0, 50);          // last 50 failed jobs
const job = failed.find((j) => j.id === '<id>');
await job.retry();                                 // moves back to wait
```

For webhook deliveries, mark the `WebhookDelivery` row as `pending` and re-enqueue via `enqueueWebhookDelivery({...})`.

## Configuration

All three queues require Redis (`REDIS_URL`). If unset, the workers are skipped at startup with a warning — reads still work, writes/webhooks/syncs become unavailable. See `packages/api/src/index.ts` (the `if (hasRedis)` block).
