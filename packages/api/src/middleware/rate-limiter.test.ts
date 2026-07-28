/**
 * Testes de `middleware/rate-limiter.ts` e, mais importante, do jeito como ele
 * é REGISTRADO.
 *
 * Este arquivo nasceu de um defeito que passou por todo mundo: os onze
 * `app.register(import('@fastify/rate-limit'), ...)` espalhados pelos arquivos
 * de rota estavam **sem `await`**, e nenhum limite jamais entrou em vigor —
 * nem o de login, nem o de 2FA, nem o `rateLimitRpm` por planilha.
 *
 * Sem o `await`, o `register` só entra na fila do Fastify. O plugin instala o
 * hook `onRequest` depois que as rotas daquele escopo já foram vinculadas, e o
 * hook não as alcança. Nada quebra, nada avisa: a chamada está lá, os
 * comentários prometem "10/min por IP", e passam mil.
 *
 * Quem apontou foi o CodeQL (`js/missing-rate-limiting`), e a primeira reação
 * foi classificar como falso positivo — o repo tem a convenção de registrar o
 * limite dentro de cada plugin de rota justamente para o CodeQL enxergar. O
 * alerta estava certo.
 *
 * Daí as duas metades daqui:
 *   1. **comportamento** — sobe o plugin de verdade e confere que o 429 chega;
 *   2. **guarda estática** — varre os arquivos de rota atrás do padrão sem
 *      `await`, porque o teste de comportamento só cobre o que alguém lembrar
 *      de exercitar, e são onze pontos.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { authRateLimitOptions, dashboardRateLimitOptions } from './rate-limiter.js';

// ---------------------------------------------------------------------------
// 1. Comportamento
// ---------------------------------------------------------------------------

/** Monta um app com uma rota atrás do limite, do jeito CERTO (com `await`). */
async function appComLimite(opcoes: Record<string, unknown>) {
  const app = Fastify({ logger: false });
  await app.register(async (escopo) => {
    await escopo.register(import('@fastify/rate-limit'), opcoes as never);
    escopo.post('/x', async () => ({ ok: true }));
  }, { prefix: '/t' });
  await app.ready();
  return app;
}

async function statusDe(app: FastifyInstance, vezes: number, ip?: string) {
  const status: number[] = [];
  for (let i = 0; i < vezes; i++) {
    const r = await app.inject({
      method: 'POST',
      url: '/t/x',
      payload: {},
      ...(ip ? { remoteAddress: ip } : {}),
    });
    status.push(r.statusCode);
  }
  return status;
}

describe('authRateLimitOptions — 10 por minuto, por IP', () => {
  it('deixa passar os 10 primeiros e barra o 11º', async () => {
    const app = await appComLimite(authRateLimitOptions());
    try {
      const status = await statusDe(app, 12);

      expect(status.slice(0, 10).every((s) => s === 200)).toBe(true);
      expect(status[10]).toBe(429);
      expect(status[11]).toBe(429);
    } finally {
      await app.close();
    }
  });

  it('o balde é por IP — um cliente abusivo não derruba o login dos outros', async () => {
    const app = await appComLimite(authRateLimitOptions());
    try {
      await statusDe(app, 12, '203.0.113.1');
      const outro = await statusDe(app, 1, '198.51.100.9');

      expect(outro[0]).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('dashboardRateLimitOptions', () => {
  it('é mais permissivo que o de auth — uso normal da UI não pode esbarrar', () => {
    expect(dashboardRateLimitOptions().max).toBeGreaterThan(authRateLimitOptions().max);
  });

  it('chaveia por usuário quando há sessão, e por IP quando não há', () => {
    const gerar = dashboardRateLimitOptions().keyGenerator;

    expect(gerar({ user: { sub: 'u1' }, ip: '203.0.113.1' } as never)).toContain('u1');
    expect(gerar({ ip: '203.0.113.1' } as never)).toContain('203.0.113.1');
  });

  it('os dois usam prefixos distintos — os baldes não se misturam', () => {
    const auth = authRateLimitOptions().keyGenerator({ ip: '203.0.113.1' } as never);
    const dash = dashboardRateLimitOptions().keyGenerator({ ip: '203.0.113.1' } as never);

    expect(auth).not.toBe(dash);
  });
});

// ---------------------------------------------------------------------------
// 2. Guarda estática
// ---------------------------------------------------------------------------

function arquivosDeRota(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) return arquivosDeRota(caminho);
    return nome.endsWith('.ts') && !nome.endsWith('.test.ts') ? [caminho] : [];
  });
}

describe('registro do rate limit nos arquivos de rota', () => {
  const arquivos = arquivosDeRota(new URL('../routes', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

  it('encontra os arquivos de rota (senão a varredura não prova nada)', () => {
    // Guarda contra a guarda: se a resolução de caminho quebrar, a lista viria
    // vazia e todos os testes abaixo passariam sem olhar uma linha.
    expect(arquivos.length).toBeGreaterThanOrEqual(10);
  });

  it('TODO registro de @fastify/rate-limit é awaited', () => {
    const semAwait: string[] = [];

    for (const arquivo of arquivos) {
      const linhas = readFileSync(arquivo, 'utf8').split('\n');
      linhas.forEach((linha, i) => {
        if (!linha.includes("register(import('@fastify/rate-limit')")) return;
        if (linha.includes('await ')) return;
        semAwait.push(`${arquivo}:${i + 1}`);
      });
    }

    expect(semAwait).toEqual([]);
  });

  it('a varredura de fato enxerga os registros (não está casando com nada)', () => {
    // Contraponto do teste acima: se o padrão de busca envelhecer — outro nome
    // de pacote, outra forma de importar —, `semAwait` viraria `[]` por não
    // achar nada, e o teste passaria justamente quando parou de proteger.
    const comRegistro = arquivos.filter((a) =>
      readFileSync(a, 'utf8').includes("register(import('@fastify/rate-limit')"),
    );

    expect(comRegistro.length).toBeGreaterThanOrEqual(10);
  });
});
