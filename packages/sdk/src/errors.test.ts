/**
 * Testes de `errors.ts` — as duas classes que o consumidor do SDK põe no
 * `catch`.
 *
 * Por que testar dez linhas de classe: subclasse de `Error` em TypeScript
 * compilado para alvo antigo é um clássico de `instanceof` quebrado (o
 * `Object.setPrototypeOf` que o downlevel do TS exige). Se `instanceof
 * SheetsBancoError` devolver `false` na build publicada, todo `catch` do
 * consumidor cai no ramo genérico e ninguém descobre até a produção do outro.
 * Aqui isso fica travado — junto com a cadeia `NetworkError extends
 * SheetsBancoError extends Error`, que é o que permite um `catch` só para os
 * dois casos.
 *
 * O `tsup` gera CJS e ESM a partir deste mesmo fonte; o teste roda sobre o
 * fonte, então cobre o comportamento, não a build.
 */
import { describe, it, expect } from 'vitest';
import { SheetsBancoError, NetworkError } from './index.js';

describe('SheetsBancoError', () => {
  it('guarda status, code e message como recebidos', () => {
    const e = new SheetsBancoError(404, 'API_NOT_FOUND', 'API not found');
    expect(e.status).toBe(404);
    expect(e.code).toBe('API_NOT_FOUND');
    expect(e.message).toBe('API not found');
  });

  it('é um Error de verdade — instanceof, name e stack', () => {
    const e = new SheetsBancoError(500, 'INTERNAL_ERROR', 'boom');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(SheetsBancoError);
    expect(e.name).toBe('SheetsBancoError');
    expect(typeof e.stack).toBe('string');
    expect(e.stack).toContain('SheetsBancoError');
  });

  it('pode ser lançado e capturado por tipo', () => {
    expect(() => {
      throw new SheetsBancoError(403, 'CREATE_DISABLED', 'disabled');
    }).toThrow(SheetsBancoError);
  });

  it('status e code são readonly — o TypeScript recusa reescrevê-los', () => {
    // Antes eram `public status` / `public code` sem `readonly`, e nada impedia
    // um middleware do consumidor de reescrever o código do erro depois de
    // capturá-lo — e aí o log contaria outra história.
    //
    // A garantia é de compilação, então o teste dela é o `@ts-expect-error`:
    // se alguém tirar o `readonly`, a diretiva vira erro ("unused
    // ts-expect-error") e o typecheck quebra.
    const e = new SheetsBancoError(404, 'API_NOT_FOUND', 'x');
    // @ts-expect-error readonly
    e.code = 'OUTRA_COISA';
    // @ts-expect-error readonly
    e.status = 200;
  });

  it('carrega request_id e o corpo cru da resposta', () => {
    // O envelope da API tem cinco campos e o `request_id` é o que correlaciona
    // o problema do consumidor com a linha de log do servidor. Antes o
    // construtor recebia só (status, code, message) e o id era descartado.
    const e = new SheetsBancoError(404, 'API_NOT_FOUND', 'x', {
      requestId: 'req_abc123',
      body: { error: true, code: 'API_NOT_FOUND' },
    });

    expect(e.requestId).toBe('req_abc123');
    expect(e.body).toEqual({ error: true, code: 'API_NOT_FOUND' });
  });

  it('JSON.stringify do erro leva a mensagem — é o que os loggers fazem', () => {
    // `message` mora no protótipo de `Error` e não é enumerável, então sumia no
    // stringify: o log do consumidor registrava "API_NOT_FOUND" sem dizer o que
    // não foi encontrado. O `toJSON()` da classe resolve.
    const e = new SheetsBancoError(404, 'API_NOT_FOUND', 'API not found', {
      requestId: 'req_xyz',
    });
    const serializado = JSON.parse(JSON.stringify(e));

    expect(serializado).toEqual({
      name: 'SheetsBancoError',
      message: 'API not found',
      status: 404,
      code: 'API_NOT_FOUND',
      requestId: 'req_xyz',
    });
    // `toString()` continua funcionando e é o caminho seguro para log:
    expect(String(e)).toBe('SheetsBancoError: API not found');
  });
});

describe('NetworkError', () => {
  it('nasce com status 0 e code NETWORK_ERROR', () => {
    const e = new NetworkError('fetch failed');
    expect(e.status).toBe(0);
    expect(e.code).toBe('NETWORK_ERROR');
    expect(e.message).toBe('fetch failed');
    expect(e.name).toBe('NetworkError');
  });

  it('herda de SheetsBancoError — um catch só cobre API e rede', () => {
    const e = new NetworkError('socket hang up');
    expect(e).toBeInstanceOf(NetworkError);
    expect(e).toBeInstanceOf(SheetsBancoError);
    expect(e).toBeInstanceOf(Error);
  });

  it('status 0 é o que distingue "rede caiu" de "API respondeu erro"', () => {
    // Contraponto: sem esta diferença, o consumidor não teria como decidir se
    // vale a pena tentar de novo. Nenhum status HTTP real é 0.
    const rede = new NetworkError('fetch failed');
    const api = new SheetsBancoError(500, 'INTERNAL_ERROR', 'boom');
    expect(rede.status).toBe(0);
    expect(api.status).toBeGreaterThan(0);
  });

  it('o caminho inverso não vale: SheetsBancoError não é NetworkError', () => {
    const api = new SheetsBancoError(0, 'NETWORK_ERROR', 'imitação');
    expect(api).not.toBeInstanceOf(NetworkError);
  });
});

describe('superfície pública do pacote', () => {
  it('index reexporta as duas classes de erro e o cliente', async () => {
    // Quebrar o `index.ts` é a forma mais silenciosa de quebrar o consumidor:
    // o build passa, o typecheck passa, e o `import { NetworkError }` do outro
    // projeto vira `undefined` em tempo de execução.
    const pacote = await import('./index.js');
    expect(typeof pacote.SheetsBanco).toBe('function');
    expect(typeof pacote.SheetsBancoError).toBe('function');
    expect(typeof pacote.NetworkError).toBe('function');
  });
});
