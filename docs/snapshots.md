# Snapshots & versioned reads

A snapshot is a point-in-time copy of a sheet's rows, stored in the API's database. They give you two things:

- **Time-travel reads** — `GET /api/v1/:apiId?version=N` returns the rows as they were at snapshot `N`.
- **Audit** — list of who-snapshotted-when, with row counts.

Snapshots are owned per-SheetApi and versioned monotonically (1, 2, 3, …) per API. Versions are *not* globally unique.

## Creating a snapshot

### Manually (dashboard API)

```bash
curl -X POST "https://api.example.com/dashboard/apis/<id>/snapshots?sheet=Agenda" \
  -H "Authorization: Bearer <JWT>"
```

The optional `?sheet=` selects a worksheet tab; omit for the API's default sheet. Response carries the new snapshot row including `version`, `rowCount`, and `headers`.

### Automatically on every write

Set `autoSnapshotOnWrite: true` on the SheetApi. The write worker will then call the snapshot path right before each successful write. Useful when you want a rollback target for every change without writing a UI button.

```bash
curl -X PATCH "https://api.example.com/dashboard/apis/<id>" \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"autoSnapshotOnWrite": true}'
```

## Listing snapshots

```bash
curl "https://api.example.com/dashboard/apis/<id>/snapshots" \
  -H "Authorization: Bearer <JWT>"
```

Returns metadata only (no `data` payload) ordered by version desc:

```json
{
  "snapshots": [
    {
      "id": "cm...",
      "version": 42,
      "headers": ["nome", "cpf", "cargo"],
      "rowCount": 1287,
      "sheetName": "Coordenadores",
      "createdAt": "2026-06-17T22:14:09.000Z"
    }
  ]
}
```

## Reading a versioned snapshot

There are two paths.

### Public API path (`?version=N`)

```bash
curl "https://api.example.com/api/v1/<apiId>?version=42&limit=10"
```

Subject to the same per-API auth (bearer / basic / HMAC / IP / CORS / rate limit) as a normal read. Pagination, sorting, and `cast_numbers` apply on top of the snapshot's stored rows. `cast_numbers` and `single_object` work; search/`?filter=` does not (snapshot route returns the raw stored array).

### Dashboard path (full payload)

```bash
curl "https://api.example.com/dashboard/apis/<id>/snapshots/42" \
  -H "Authorization: Bearer <JWT>"
```

Returns the full `data` array along with metadata. Use this for the rollback / inspection UI; use the public path for application reads against historical data.

## Deleting a snapshot

```bash
curl -X DELETE "https://api.example.com/dashboard/apis/<id>/snapshots/42" \
  -H "Authorization: Bearer <JWT>"
```

Hard delete. Other versions are unaffected; version numbers stay sparse (deleting v42 doesn't renumber v43+).

## Storage and growth

Today, `Snapshot.data` is a Postgres `JSONB` column with the full rows array. A sheet with 1,000 rows × 20 columns at ~50 chars per cell is roughly 1 MB per snapshot. Combined with `autoSnapshotOnWrite`, this grows fast.

**Operational guidance for the current setup:**

- **Don't enable `autoSnapshotOnWrite` on high-volume APIs** unless you have a retention policy. Snapshots accumulate; Postgres has no automatic GC.
- **Periodically prune** — list snapshots, delete the ones older than your audit horizon. There's no built-in retention; this is a manual operator task.
- **Watch Supabase usage** — 500 MB free tier. A handful of large auto-snapshotted APIs can hit the ceiling in weeks.

### Planned: object storage migration

The current row-in-Postgres design doesn't scale. Migration plan (tracked in #66):

1. Add an `S3-compatible` backend (Cloudflare R2 is the target — 10 GB free + zero egress).
2. New `Snapshot.storageRef` column (e.g. `r2://sheets-banco/snap/<id>.json`).
3. Writes: serialize → upload → leave `data` null + populate `storageRef`.
4. Reads: prefer `storageRef`; fall back to legacy `data`.
5. Optional backfill: stream existing rows to R2.
6. After a confidence window with zero fallbacks, drop the `data` column.

That work is **deferred until DB-size pressure becomes measurable** (Supabase usage > 30% of free tier sustained, or a single SheetApi > 50 MB total snapshot rows). No urgency before that — the row-in-Postgres design is simpler and the latency is better. The trigger to take it on is a real number, not a feeling.

If/when it lands, the read path is transparent — `?version=N` keeps working with the same semantics.

## Edge cases

- **Snapshotting an empty sheet** is allowed. You get `rowCount: 0` and `data: []`. Useful as a baseline "before first import" marker.
- **Snapshotting while a write is in flight:** snapshots read live data via the same Google Sheets path, so they see whatever the Sheet has at the moment of the snapshot. If the write hasn't landed in Google yet, the snapshot won't reflect it. (Sequence matters; if precise ordering is critical, snapshot from a write success hook, not in parallel.)
- **`autoSnapshotOnWrite` and write failures:** if the write fails, no snapshot is created. The flag is "snapshot before each successful write," not "snapshot before every attempt."
- **Per-tab snapshots:** the `sheet` query at create time controls which tab is captured. The route doesn't snapshot all tabs at once.
