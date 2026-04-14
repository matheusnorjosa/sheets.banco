import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import * as cache from './cache.service.js';

interface CachedCredentials {
  accessToken: string;
  refreshToken: string;
  expiryDate: number | null;
}

/**
 * Get an authenticated OAuth2 client for a user.
 * Uses Redis cache to avoid hitting the database on every request.
 * Handles automatic token refresh and persistence.
 */
export async function getOAuthClient(userId: string): Promise<OAuth2Client> {
  const oauth2Client = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );

  // Try cache first
  const cacheKey = `oauth:${userId}`;
  const cached = await cache.get<CachedCredentials>(cacheKey);

  if (cached) {
    oauth2Client.setCredentials({
      access_token: cached.accessToken,
      refresh_token: cached.refreshToken,
      expiry_date: cached.expiryDate,
    });
  } else {
    // Fetch from database
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.googleAccessToken || !user?.googleRefreshToken) {
      throw new AppError(403, 'GOOGLE_NOT_CONNECTED', 'Google account not connected. Please authorize Google access.');
    }

    oauth2Client.setCredentials({
      access_token: user.googleAccessToken,
      refresh_token: user.googleRefreshToken,
      expiry_date: user.googleTokenExpiry?.getTime() ?? null,
    });

    // Cache credentials (TTL = time until token expiry, max 50 min)
    const ttl = computeTtl(user.googleTokenExpiry);
    await cache.set(cacheKey, {
      accessToken: user.googleAccessToken,
      refreshToken: user.googleRefreshToken,
      expiryDate: user.googleTokenExpiry?.getTime() ?? null,
    }, ttl);
  }

  // Listen for token refreshes and persist them
  oauth2Client.on('tokens', async (tokens) => {
    const update: Record<string, unknown> = {};
    if (tokens.access_token) update.googleAccessToken = tokens.access_token;
    if (tokens.refresh_token) update.googleRefreshToken = tokens.refresh_token;
    if (tokens.expiry_date) update.googleTokenExpiry = new Date(tokens.expiry_date);

    if (Object.keys(update).length > 0) {
      // Update database
      await prisma.user.update({ where: { id: userId }, data: update });

      // Update cache with new credentials
      const newCreds: CachedCredentials = {
        accessToken: (tokens.access_token ?? oauth2Client.credentials.access_token) as string,
        refreshToken: (tokens.refresh_token ?? oauth2Client.credentials.refresh_token) as string,
        expiryDate: tokens.expiry_date ?? null,
      };
      const ttl = tokens.expiry_date ? computeTtl(new Date(tokens.expiry_date)) : 3000;
      await cache.set(cacheKey, newCreds, ttl);
    }
  });

  return oauth2Client;
}

/**
 * Invalidate cached OAuth credentials for a user (e.g., on disconnect).
 */
export async function invalidateOAuthCache(userId: string): Promise<void> {
  await cache.del(`oauth:${userId}`);
}

/**
 * Compute cache TTL based on token expiry.
 * Caches for (expiry - 5 minutes) or max 50 minutes.
 */
function computeTtl(expiry: Date | null | undefined): number {
  if (!expiry) return 3000; // 50 min default

  const msUntilExpiry = expiry.getTime() - Date.now();
  const secondsUntilExpiry = Math.floor(msUntilExpiry / 1000);

  // Cache until 5 minutes before expiry, max 50 min
  return Math.max(60, Math.min(secondsUntilExpiry - 300, 3000));
}
