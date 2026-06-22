import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// vi.mock is hoisted above imports — using vi.hoisted to share the spy
// with the factory while keeping a reference for assertions below.
const { createManyMock } = vi.hoisted(() => ({
  createManyMock: vi.fn<(args: { data: Array<Record<string, unknown>> }) => Promise<{ count: number }>>(async () => ({ count: 0 })),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    usageLog: { createMany: createManyMock },
  },
}));

import {
  enqueueUsageLog,
  flushUsageLog,
  __resetUsageLogForTests,
} from './usage.service.js';

const baseEntry = {
  sheetApiId: 'sheet-1',
  method: 'GET',
  path: '/api/v1/sheet-1',
  statusCode: 200,
  responseMs: 12,
  ip: '127.0.0.1',
};

beforeEach(() => {
  vi.useFakeTimers();
  createManyMock.mockClear();
  __resetUsageLogForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('enqueueUsageLog', () => {
  it('does NOT call DB on a single enqueue (sits in the buffer)', () => {
    enqueueUsageLog(baseEntry);
    expect(createManyMock).not.toHaveBeenCalled();
  });

  it('does NOT call DB after 99 enqueues (under BATCH_LIMIT=100)', () => {
    for (let i = 0; i < 99; i++) enqueueUsageLog(baseEntry);
    expect(createManyMock).not.toHaveBeenCalled();
  });

  it('flushes synchronously when buffer hits BATCH_LIMIT (100)', () => {
    for (let i = 0; i < 100; i++) enqueueUsageLog(baseEntry);
    expect(createManyMock).toHaveBeenCalledTimes(1);
    expect(createManyMock.mock.calls[0]![0]!.data).toHaveLength(100);
  });

  it('flushes via the 30s timer once an entry is buffered', () => {
    enqueueUsageLog(baseEntry);
    expect(createManyMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(createManyMock).toHaveBeenCalledTimes(1);
    expect(createManyMock.mock.calls[0]![0]!.data).toHaveLength(1);
  });

  it('timer with empty buffer is a no-op (no DB call) — the Neon-wake fix', () => {
    enqueueUsageLog(baseEntry);
    vi.advanceTimersByTime(30_000); // flush 1
    expect(createManyMock).toHaveBeenCalledTimes(1);
    createManyMock.mockClear();
    vi.advanceTimersByTime(30_000); // timer ticks again, buffer empty
    expect(createManyMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000); // 2 more idle ticks
    expect(createManyMock).not.toHaveBeenCalled();
  });

  it('preserves entry shape on createMany (column mapping)', () => {
    enqueueUsageLog({
      sheetApiId: 'sheet-x',
      method: 'POST',
      path: '/api/v1/sheet-x',
      statusCode: 201,
      responseMs: 88,
      ip: null,
    });
    vi.advanceTimersByTime(30_000);
    expect(createManyMock).toHaveBeenCalledWith({
      data: [{
        sheetApiId: 'sheet-x',
        method: 'POST',
        path: '/api/v1/sheet-x',
        statusCode: 201,
        responseMs: 88,
        ip: null,
      }],
    });
  });

  it('normalizes undefined ip to null on insert', () => {
    enqueueUsageLog({
      sheetApiId: 'sheet-x',
      method: 'GET',
      path: '/api/v1/sheet-x',
      statusCode: 200,
      responseMs: 5,
      // ip omitted on purpose
    } as any);
    vi.advanceTimersByTime(30_000);
    expect(createManyMock.mock.calls[0]![0]!.data[0]!.ip).toBeNull();
  });

  it('swallows DB errors silently (telemetry must not break the app)', async () => {
    createManyMock.mockRejectedValueOnce(new Error('connection refused'));
    enqueueUsageLog(baseEntry);
    // Triggering BATCH_LIMIT to force a flush + assert no throw
    expect(() => {
      for (let i = 0; i < 99; i++) enqueueUsageLog(baseEntry);
    }).not.toThrow();
  });
});

describe('flushUsageLog (shutdown)', () => {
  it('flushes remaining entries and stops the timer', async () => {
    enqueueUsageLog(baseEntry);
    enqueueUsageLog(baseEntry);
    enqueueUsageLog(baseEntry);
    await flushUsageLog();
    expect(createManyMock).toHaveBeenCalledTimes(1);
    expect(createManyMock.mock.calls[0]![0]!.data).toHaveLength(3);
    // Timer cleared — further ticks shouldn't re-fire
    createManyMock.mockClear();
    vi.advanceTimersByTime(60_000);
    expect(createManyMock).not.toHaveBeenCalled();
  });

  it('is a no-op when buffer is empty (still safe to call)', async () => {
    await flushUsageLog();
    expect(createManyMock).not.toHaveBeenCalled();
  });
});
