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

  it('ACHADO: status e code são públicos e MUTÁVEIS', () => {
    // Declarados como `public status` / `public code`, sem `readonly`. Nada
    // impede um middleware do consumidor de reescrever o código do erro depois
    // de capturá-lo — e aí o log conta outra história.
    const e = new SheetsBancoError(404, 'API_NOT_FOUND', 'x');
    e.code = 'OUTRA_COISA';
    e.status = 200;
    expect(e.code).toBe('OUTRA_COISA');
    expect(e.status).toBe(200);
  });

  it('ACHADO: não há campo para request_id nem para o corpo da resposta', () => {
    // O construtor tem três parâmetros. O envelope da API tem cinco campos
    // (`error`, `message`, `code`, `statusCode`, `request_id`) — os dois que
    // faltam são justamente os que servem para correlacionar com o log do
    // servidor. Ver o ACHADO correspondente em `client.test.ts`.
    expect(SheetsBancoError.length).toBe(3);
    const e = new SheetsBancoError(404, 'API_NOT_FOUND', 'x');
    // `name` aparece porque o construtor faz `this.name = ...`, o que cria uma
    // propriedade própria e enumerável em cima da do protótipo de `Error`.
    expect(Object.keys(e).sort()).toEqual(['code', 'name', 'status']);
  });

  it('ACHADO: JSON.stringify do erro leva status e code, mas PERDE a mensagem', () => {
    // `message` fica no protótipo de `Error` e não é enumerável, então some no
    // stringify — e é exatamente isso que muitos loggers fazem com um objeto de
    // erro. Sobram `status`, `code` e `name` (campos próprios). Ou seja: o log
    // do consumidor registra "API_NOT_FOUND" sem dizer o que não foi encontrado.
    const e = new SheetsBancoError(404, 'API_NOT_FOUND', 'API not found');
    const serializado = JSON.parse(JSON.stringify(e));
    expect(serializado).toEqual({
      status: 404,
      code: 'API_NOT_FOUND',
      name: 'SheetsBancoError',
    });
    expect(serializado.message).toBeUndefined();
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
