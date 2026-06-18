import type { SheetApi } from '../services/sheet-api-cache.service.js';

/**
 * Module augmentation for Fastify — the per-API resolver middleware attaches
 * the resolved SheetApi record to `request.sheetApi`, and downstream
 * middleware/handlers read it. Declaring it here removes ~10 `(request as any)`
 * casts that hide bugs and skip type-checking.
 */
declare module 'fastify' {
  interface FastifyRequest {
    sheetApi?: SheetApi;
    /**
     * Raw request body bytes captured by `fastify-raw-body`. Used by
     * `hmac-verify` middleware for `X-Signature-Version: 2`, which signs the
     * exact bytes the client sent (independent of JSON serializer behavior).
     * Undefined for routes that don't enable rawBody capture.
     */
    rawBody?: string | Buffer;
  }
}

export {};
