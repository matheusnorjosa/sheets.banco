import type IORedis from 'ioredis';

let redis: InstanceType<typeof import('ioredis').default> | null = null;

/**
 * Initialize cache with a Redis connection.
 * Must be called after the Redis plugin is registered.
 */
export function initCache(redisInstance: any): void {
  redis = redisInstance;
}

export async function get<T>(key: string): Promise<T | undefined> {
  if (!redis) return undefined;

  try {
    const data = await redis.get(key);
    if (!data) return undefined;
    return JSON.parse(data) as T;
  } catch {
    return undefined;
  }
}

export async function set<T>(key: string, data: T, ttlSeconds: number): Promise<void> {
  if (!redis) return;

  try {
    await redis.setex(key, ttlSeconds, JSON.stringify(data));
  } catch {
    // Silently fail — cache is best-effort
  }
}

export async function invalidate(prefix: string): Promise<void> {
  if (!redis) return;

  try {
    const stream = redis.scanStream({ match: `${prefix}*`, count: 100 });
    const keys: string[] = [];

    for await (const batch of stream) {
      keys.push(...(batch as string[]));
    }

    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch {
    // Silently fail
  }
}

export async function del(key: string): Promise<void> {
  if (!redis) return;

  try {
    await redis.del(key);
  } catch {
    // Silently fail
  }
}
