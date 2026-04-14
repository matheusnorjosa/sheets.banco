import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, AppError } from '../../lib/errors.js';
import * as sheetsService from '../../services/google-sheets.service.js';

function inferType(values: string[]): string {
  if (values.length === 0) return 'string';

  const nonEmpty = values.filter((v) => v !== '');
  if (nonEmpty.length === 0) return 'string';

  const allBool = nonEmpty.every((v) => v === 'true' || v === 'false');
  if (allBool) return 'boolean';

  const allNum = nonEmpty.every((v) => !isNaN(Number(v)));
  if (allNum) return 'number';

  return 'string';
}

export async function schemaRoutes(app: FastifyInstance) {
  // GET /api/v1/:apiId/schema — return column types inferred from data
  app.get('/:apiId/schema', async (request) => {
    const { apiId } = request.params as { apiId: string };

    let sheetApi = await prisma.sheetApi.findUnique({ where: { id: apiId } });
    if (!sheetApi) {
      sheetApi = await prisma.sheetApi.findUnique({ where: { slug: apiId } });
    }
    if (!sheetApi || !sheetApi.userId) throw new NotFoundError('API not found.');

    const query = (request.query ?? {}) as Record<string, string>;
    const rows = await sheetsService.getRows(sheetApi.userId, sheetApi.spreadsheetId, query.sheet, sheetApi.cacheTtlSeconds);

    if (rows.length === 0) {
      const cols = await sheetsService.getColumnNames(sheetApi.userId, sheetApi.spreadsheetId, query.sheet);
      return {
        columns: cols.map((name) => ({ name, type: 'string' })),
      };
    }

    const headers = Object.keys(rows[0]);
    const sampleSize = Math.min(rows.length, 100);
    const columns = headers.map((name) => {
      const values = rows.slice(0, sampleSize).map((r) => r[name] ?? '');
      return { name, type: inferType(values) };
    });

    return { columns, sampleSize, totalRows: rows.length };
  });

  // GET /api/v1/:apiId/openapi.json — per-API OpenAPI spec
  app.get('/:apiId/openapi.json', async (request) => {
    const { apiId } = request.params as { apiId: string };

    let sheetApi = await prisma.sheetApi.findUnique({ where: { id: apiId } });
    if (!sheetApi) {
      sheetApi = await prisma.sheetApi.findUnique({ where: { slug: apiId } });
    }
    if (!sheetApi || !sheetApi.userId) throw new NotFoundError('API not found.');

    const cols = await sheetsService.getColumnNames(sheetApi.userId, sheetApi.spreadsheetId);
    const properties: Record<string, { type: string }> = {};
    for (const col of cols) {
      properties[col] = { type: 'string' };
    }

    const basePath = `/api/v1/${sheetApi.slug || sheetApi.id}`;

    return {
      openapi: '3.0.3',
      info: {
        title: `${sheetApi.name} API`,
        description: `Auto-generated API for spreadsheet "${sheetApi.name}"`,
        version: '1.0.0',
      },
      paths: {
        [basePath]: {
          get: {
            summary: 'Read all rows',
            parameters: [
              { name: 'limit', in: 'query', schema: { type: 'integer' } },
              { name: 'offset', in: 'query', schema: { type: 'integer' } },
              { name: 'sort_by', in: 'query', schema: { type: 'string' } },
              { name: 'sort_order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc', 'random'] } },
              { name: 'sheet', in: 'query', schema: { type: 'string' } },
            ],
            responses: {
              '200': {
                description: 'Array of row objects',
                content: { 'application/json': { schema: { type: 'array', items: { type: 'object', properties } } } },
              },
            },
          },
          post: {
            summary: 'Create rows',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: {
                        oneOf: [
                          { type: 'object', properties },
                          { type: 'array', items: { type: 'object', properties } },
                        ],
                      },
                    },
                  },
                },
              },
            },
            responses: { '201': { description: 'Rows created' }, '202': { description: 'Queued' } },
          },
        },
        [`${basePath}/search`]: {
          get: {
            summary: 'Search rows (AND)',
            parameters: cols.map((col) => ({ name: col, in: 'query', schema: { type: 'string' }, required: false })),
            responses: { '200': { description: 'Matching rows' } },
          },
        },
        [`${basePath}/keys`]: {
          get: { summary: 'Get column names', responses: { '200': { description: 'Array of column names' } } },
        },
        [`${basePath}/count`]: {
          get: { summary: 'Get row count', responses: { '200': { description: 'Row count' } } },
        },
        [`${basePath}/:column/:value`]: {
          patch: { summary: 'Update rows by column/value', responses: { '200': { description: 'Updated count' } } },
          delete: { summary: 'Delete rows by column/value', responses: { '200': { description: 'Deleted count' } } },
        },
      },
    };
  });

  // GET /api/v1/:apiId/postman.json — Postman collection for this API
  app.get('/:apiId/postman.json', async (request) => {
    const { apiId } = request.params as { apiId: string };

    let sheetApi = await prisma.sheetApi.findUnique({ where: { id: apiId } });
    if (!sheetApi) {
      sheetApi = await prisma.sheetApi.findUnique({ where: { slug: apiId } });
    }
    if (!sheetApi) throw new NotFoundError('API not found.');

    const baseUrl = `{{baseUrl}}/api/v1/${sheetApi.slug || sheetApi.id}`;

    return {
      info: {
        name: `${sheetApi.name} — sheets.banco`,
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      variable: [{ key: 'baseUrl', value: 'http://localhost:3000' }],
      item: [
        { name: 'Read all rows', request: { method: 'GET', url: { raw: baseUrl } } },
        { name: 'Search (AND)', request: { method: 'GET', url: { raw: `${baseUrl}/search?column=value` } } },
        { name: 'Get column names', request: { method: 'GET', url: { raw: `${baseUrl}/keys` } } },
        { name: 'Get row count', request: { method: 'GET', url: { raw: `${baseUrl}/count` } } },
        {
          name: 'Create rows',
          request: {
            method: 'POST',
            url: { raw: `${baseUrl}?sync=true` },
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: { mode: 'raw', raw: '{\n  "data": {\n    "column": "value"\n  }\n}' },
          },
        },
        {
          name: 'Update rows',
          request: {
            method: 'PATCH',
            url: { raw: `${baseUrl}/:column/:value?sync=true` },
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: { mode: 'raw', raw: '{\n  "data": {\n    "column": "newValue"\n  }\n}' },
          },
        },
        { name: 'Delete rows', request: { method: 'DELETE', url: { raw: `${baseUrl}/:column/:value?sync=true` } } },
        { name: 'Export CSV', request: { method: 'GET', url: { raw: `${baseUrl}/export?format=csv` } } },
        { name: 'Export JSON', request: { method: 'GET', url: { raw: `${baseUrl}/export?format=json` } } },
      ],
    };
  });
}
