/**
 * Duas metades, como em `rate-limiter.test.ts`:
 *
 *   1. **Valor.** Trava os números de polling. Não é teste de tautologia: é o
 *      que faz alguém que baixe o `drainDelay` de volta para os 5 s do default
 *      ter que justificar no diff — e são esses 5 s que queimaram a cota do
 *      Upstash em 2026-07-29.
 *   2. **Cobertura.** Varredura estática: todo `new Worker(...)` passa por
 *      `buildWorkerOptions`. Worker novo esquecido volta a vazar polling, e
 *      teste de comportamento não pega o que ninguém lembrou de exercitar.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_WORKER_OPTIONS, buildWorkerOptions } from './worker-options.js';

const conexao = { host: 'localhost', port: 6379 };

describe('DEFAULT_WORKER_OPTIONS', () => {
  it('mantém o polling folgado o suficiente para caber na cota', () => {
    // 30 s → ~2 bzpopmin/min por worker (contra 12 no default de 5 s).
    // 5 min → ~0,2 checagem de stall/min (contra 2 no default de 30 s).
    // Três workers a ~2,2/min ≈ 285 mil comandos/mês; a 14/min ≈ 1,8 milhão,
    // contra um teto de 500 mil.
    expect(DEFAULT_WORKER_OPTIONS.drainDelay).toBe(30);
    expect(DEFAULT_WORKER_OPTIONS.stalledInterval).toBe(300_000);
  });

  it('não desliga a checagem de stall', () => {
    // `skipStalledCheck: true` cortaria mais comandos e é a saída errada: é
    // essa checagem que recupera job cujo worker morreu no meio da escrita.
    // Sem ela o job se perde em silêncio.
    expect(DEFAULT_WORKER_OPTIONS.skipStalledCheck).toBeUndefined();
  });
});

describe('buildWorkerOptions', () => {
  it('aplica o polling em cima do que o worker pediu', () => {
    const opcoes = buildWorkerOptions({ connection: conexao, concurrency: 3 });
    expect(opcoes.concurrency).toBe(3);
    expect(opcoes.drainDelay).toBe(30);
    expect(opcoes.stalledInterval).toBe(300_000);
  });

  it('deixa o worker sobrescrever o polling quando precisar', () => {
    const opcoes = buildWorkerOptions({ connection: conexao, drainDelay: 5 });
    expect(opcoes.drainDelay).toBe(5);
    // O que não foi sobrescrito continua valendo.
    expect(opcoes.stalledInterval).toBe(300_000);
  });

  it('preserva limiter e connection', () => {
    const limiter = { max: 4, duration: 1000 };
    const opcoes = buildWorkerOptions({ connection: conexao, limiter });
    expect(opcoes.limiter).toEqual(limiter);
    expect(opcoes.connection).toBe(conexao);
  });
});

describe('todo worker usa buildWorkerOptions', () => {
  const dir = new URL('../workers', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const arquivos = readdirSync(dir)
    .filter((nome) => nome.endsWith('.worker.ts'))
    .map((nome) => join(dir, nome));

  it('encontra os workers (senão a varredura não prova nada)', () => {
    // Guarda contra a guarda: caminho quebrado daria lista vazia e o teste
    // abaixo passaria sem ler uma linha.
    expect(arquivos.length).toBe(3);
  });

  it('nenhum `new Worker` recebe options cru', () => {
    const semGuarda: string[] = [];

    for (const arquivo of arquivos) {
      const fonte = readFileSync(arquivo, 'utf8');
      if (!fonte.includes('new Worker')) continue;
      if (!fonte.includes('buildWorkerOptions(')) semGuarda.push(arquivo);
    }

    expect(semGuarda).toEqual([]);
  });

  it('todos os três realmente instanciam Worker', () => {
    // Contraponto: se o padrão de busca envelhecer, o teste acima passaria por
    // não achar nada em vez de por estar tudo certo.
    const comWorker = arquivos.filter((a) => readFileSync(a, 'utf8').includes('new Worker'));
    expect(comWorker.length).toBe(3);
  });
});
