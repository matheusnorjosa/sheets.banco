/**
 * Testes de caracterização de `routes/v1/import-export.ts`.
 *
 * Duas rotas, dois riscos distintos:
 *
 *   - `GET /export` é a única rota que despeja a planilha INTEIRA num arquivo.
 *     Se o gate `allowRead` parar de barrar, um vazamento não é de uma linha:
 *     é da base toda, em CSV, pronta para levar embora.
 *   - `POST /import` grava em lote a partir de arquivo enviado. Gate
 *     `allowCreate` + parsing de CSV/JSON vindo de fora.
 *
 * Nota sobre o gate de leitura: a memória do projeto registra que as rotas de
 * `sheets.ts` NÃO checam `allowRead` — só o `/export` daqui checa. Os testes
 * abaixo travam esse comportamento onde ele existe.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const sheetsService = {
  getRows: vi.fn().mockResolvedValue([]),
  appendRows: vi.fn().mockResolvedValue(2),
};
vi.mock('../../services/google-sheets.service.js', () => sheetsService);

const enqueueWrite = vi.fn().mockResolvedValue('job-1');
vi.mock('../../queues/sheets-write.queue.js', () => ({ enqueueWrite }));

let apiAtual: Record<string, unknown>;
vi.mock('../../lib/prisma.js', () => ({
  prisma: { sheetApi: { findUnique: vi.fn(async () => apiAtual) } },
}));

vi.mock('../../config/env.js', () => ({
  env: { RATE_LIMIT_MAX: 10000, RATE_LIMIT_WINDOW: '1 minute' },
}));

// Auth/CORS/IP têm suítes próprias; aqui são neutralizados para que a falha
// de um teste aponte a rota, não a credencial.
vi.mock('../../middleware/api-auth.js', () => ({ apiAuth: async () => {} }));
vi.mock('../../middleware/cors.js', () => ({ apiCors: async () => {} }));
vi.mock('../../middleware/ip-whitelist.js', () => ({ apiIpWhitelist: async () => {} }));

const { montarApp } = await import('../../test-utils/app.js');
const { importExportRoutes } = await import('./import-export.js');

let app: FastifyInstance;

function api(over: Record<string, unknown> = {}) {
  return {
    id: 'api-1',
    slug: 'minha-api',
    userId: 'user-1',
    spreadsheetId: 'planilha-abc',
    allowRead: true,
    allowCreate: true,
    allowUpdate: true,
    allowDelete: true,
    rateLimitRpm: 10000,
    ...over,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  sheetsService.getRows.mockResolvedValue([]);
  enqueueWrite.mockResolvedValue('job-1');
  apiAtual = api();
  app = await montarApp({ rotas: importExportRoutes, prefixo: '/api/v1' });
});

describe('GET /:apiId/export — despeja a planilha inteira', () => {
  it('allowRead=false bloqueia com 403 e NÃO lê a planilha', async () => {
    // O caso mais grave do arquivo: um vazamento aqui não é de uma linha, é
    // da base toda em arquivo.
    apiAtual = api({ allowRead: false });

    const r = await app.inject({ method: 'GET', url: '/api/v1/api-1/export' });

    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('READ_DISABLED');
    expect(sheetsService.getRows).not.toHaveBeenCalled();
  });

  it('exporta JSON por padrão, como download', async () => {
    sheetsService.getRows.mockResolvedValue([{ nome: 'Ana' }, { nome: 'Bia' }]);

    const r = await app.inject({ method: 'GET', url: '/api/v1/api-1/export' });

    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/json');
    expect(r.headers['content-disposition']).toContain('minha-api.json');
    expect(r.json()).toHaveLength(2);
  });

  it('exporta CSV com ?format=csv, com cabeçalho', async () => {
    sheetsService.getRows.mockResolvedValue([
      { nome: 'Ana', idade: '30' },
      { nome: 'Bia', idade: '25' },
    ]);

    const r = await app.inject({ method: 'GET', url: '/api/v1/api-1/export?format=csv' });

    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toContain('minha-api.csv');
    expect(r.payload).toContain('nome');
    expect(r.payload).toContain('Ana');
    expect(r.payload).toContain('Bia');
  });

  it('CSV de planilha vazia devolve corpo vazio, não quebra', async () => {
    sheetsService.getRows.mockResolvedValue([]);
    const r = await app.inject({ method: 'GET', url: '/api/v1/api-1/export?format=csv' });
    expect(r.statusCode).toBe(200);
    expect(r.payload).toBe('');
  });

  it('usa o id no nome do arquivo quando não há slug', async () => {
    apiAtual = api({ slug: null });
    sheetsService.getRows.mockResolvedValue([{ a: '1' }]);
    const r = await app.inject({ method: 'GET', url: '/api/v1/api-1/export' });
    expect(r.headers['content-disposition']).toContain('api-1.json');
  });

  it('repassa ?sheet= — sem ele vem só a primeira aba', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/api-1/export?sheet=Vidas' });
    expect(sheetsService.getRows.mock.calls[0]?.[2]).toBe('Vidas');
  });
});

describe('POST /:apiId/import', () => {
  /** Monta um upload multipart mínimo, do jeito que o Fastify espera. */
  function upload(nome: string, conteudo: string, tipo: string) {
    const limite = '----teste';
    const corpo =
      `--${limite}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${nome}"\r\n` +
      `Content-Type: ${tipo}\r\n\r\n` +
      `${conteudo}\r\n` +
      `--${limite}--\r\n`;
    return {
      payload: corpo,
      headers: { 'content-type': `multipart/form-data; boundary=${limite}` },
    };
  }

  it('allowCreate=false bloqueia com 403 e NÃO grava', async () => {
    apiAtual = api({ allowCreate: false });

    const r = await app.inject({
      method: 'POST', url: '/api/v1/api-1/import',
      ...upload('dados.csv', 'nome\nAna', 'text/csv'),
    });

    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('CREATE_DISABLED');
    expect(sheetsService.appendRows).not.toHaveBeenCalled();
    expect(enqueueWrite).not.toHaveBeenCalled();
  });

  it('importa CSV', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/v1/api-1/import?sync=true',
      ...upload('dados.csv', 'nome,idade\nAna,30\nBia,25', 'text/csv'),
    });

    expect([200, 201, 202]).toContain(r.statusCode);
    const linhas = sheetsService.appendRows.mock.calls[0]?.[2]
      ?? enqueueWrite.mock.calls[0]?.[0]?.rows;
    expect(linhas).toHaveLength(2);
    expect(linhas[0]).toMatchObject({ nome: 'Ana', idade: '30' });
  });

  it('importa JSON e converte todo valor para string', async () => {
    // A planilha só guarda texto: o import normaliza número e booleano para
    // string antes de gravar. Sem isso, o dado ia inconsistente.
    const r = await app.inject({
      method: 'POST', url: '/api/v1/api-1/import?sync=true',
      ...upload('dados.json', JSON.stringify([{ nome: 'Ana', idade: 30, ativo: true }]), 'application/json'),
    });

    expect([200, 201, 202]).toContain(r.statusCode);
    const linhas = sheetsService.appendRows.mock.calls[0]?.[2]
      ?? enqueueWrite.mock.calls[0]?.[0]?.rows;
    expect(linhas[0]).toEqual({ nome: 'Ana', idade: '30', ativo: 'true' });
  });

  it('sem arquivo dá 400', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/v1/api-1/import',
      headers: { 'content-type': 'multipart/form-data; boundary=----vazio' },
      payload: '------vazio--\r\n',
    });
    expect(r.statusCode).toBe(400);
  });
});
