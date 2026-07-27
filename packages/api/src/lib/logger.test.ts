/**
 * Testes de caracterização de `lib/logger.ts`.
 *
 * São só 2 statements, mas o valor não está no código e sim na LISTA
 * `redactPaths`: ela é a defesa em profundidade que veio junto com a
 * criptografia de token do PR #115. Se alguém apagar uma entrada dessa lista,
 * o CPF ou o refresh token do Google passa a sair em texto claro no log de
 * produção — e nada avisa, porque nenhum teste quebra.
 *
 * Por isso aqui NÃO se compara a lista com ela mesma (tautologia). Monta-se um
 * pino de verdade escrevendo num destino em memória, loga-se um objeto com os
 * campos sensíveis e confere-se que a saída veio `[REDACTED]`. O teste também
 * trava o ALCANCE real da redação (curinga de um nível só) e prova que campo
 * não sensível passa intacto — senão o teste não distinguiria redação de
 * destruição do log.
 */
import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';

// `logger.ts` lê `env.LOG_LEVEL` na importação, e `config/env.ts` valida o
// ambiente e chama `process.exit(1)` sem DATABASE_URL.
vi.mock('../config/env.js', () => ({
  env: { LOG_LEVEL: 'debug' },
}));

const { redactPaths, logger } = await import('./logger.js');

interface LinhaDeLog {
  [chave: string]: unknown;
}

/**
 * Cria um pino real com a MESMA configuração de redação do módulo alvo,
 * escrevendo num array em memória em vez de stdout.
 */
function criarLoggerEmMemoria() {
  const linhas: LinhaDeLog[] = [];
  const destino = {
    write(linha: string) {
      linhas.push(JSON.parse(linha) as LinhaDeLog);
    },
  };
  const log = pino(
    { level: 'trace', redact: { paths: redactPaths, censor: '[REDACTED]' } },
    destino as unknown as NodeJS.WritableStream,
  );
  return { log, linhas };
}

/** Loga um objeto e devolve a única linha resultante já parseada. */
function logar(objeto: Record<string, unknown>): LinhaDeLog {
  const { log, linhas } = criarLoggerEmMemoria();
  log.info(objeto, 'mensagem de teste');
  expect(linhas).toHaveLength(1);
  return linhas[0] as LinhaDeLog;
}

const CENSURA = '[REDACTED]';

/** Campos que a lista promete redigir no topo do objeto logado. */
const CAMPOS_SENSIVEIS_TOPO = [
  'password',
  'passwordHash',
  'hmacSecret',
  'secret',
  'bearerToken',
  'bearerTokenHash',
  'basicPass',
  'basicPassHash',
  'keyHash',
  'googleAccessToken',
  'googleRefreshToken',
  'cpf',
] as const;

/** Campos que a lista promete redigir um nível abaixo (curinga `*.campo`). */
const CAMPOS_SENSIVEIS_UM_NIVEL = [
  'password',
  'passwordHash',
  'hmacSecret',
  'secret',
  'bearerToken',
  'basicPass',
  'googleAccessToken',
  'googleRefreshToken',
  'cpf',
] as const;

describe('redactPaths — segredos e PII no topo do objeto', () => {
  it.each(CAMPOS_SENSIVEIS_TOPO)('redige `%s` logado na raiz', (campo) => {
    const linha = logar({ [campo]: 'valor-super-secreto-em-texto-claro' });
    expect(linha[campo]).toBe(CENSURA);
  });

  it('redige todos os campos sensíveis de uma vez no mesmo objeto', () => {
    const payload = Object.fromEntries(
      CAMPOS_SENSIVEIS_TOPO.map((campo) => [campo, `vazou-${campo}`]),
    );
    const linha = logar(payload);
    for (const campo of CAMPOS_SENSIVEIS_TOPO) {
      expect(linha[campo]).toBe(CENSURA);
    }
    // Nenhum valor original sobrou na linha serializada.
    expect(JSON.stringify(linha)).not.toContain('vazou-');
  });
});

describe('redactPaths — segredos e PII um nível abaixo', () => {
  it.each(CAMPOS_SENSIVEIS_UM_NIVEL)('redige `usuario.%s`', (campo) => {
    const linha = logar({ usuario: { id: 'u-1', [campo]: 'valor-secreto' } });
    const usuario = linha.usuario as Record<string, unknown>;
    expect(usuario[campo]).toBe(CENSURA);
    // O irmão não sensível continua legível — redação, não destruição.
    expect(usuario.id).toBe('u-1');
  });

  it('o curinga vale para QUALQUER nome de pai, não só nomes conhecidos', () => {
    const linha = logar({ qualquerCoisa: { cpf: '123.456.789-00' } });
    expect((linha.qualquerCoisa as Record<string, unknown>).cpf).toBe(CENSURA);
  });
});

describe('redactPaths — headers que carregam credencial', () => {
  it('redige authorization, cookie e x-api-key em req.headers', () => {
    const linha = logar({
      req: {
        method: 'GET',
        url: '/api/v1/minha-api',
        headers: {
          authorization: 'Bearer token-de-producao',
          cookie: 'session=abc123',
          'x-api-key': 'sk_live_naoDeveriaAparecer',
          'x-signature': 'sha256=deadbeef',
          'content-type': 'application/json',
        },
      },
    });

    const req = linha.req as Record<string, unknown>;
    const headers = req.headers as Record<string, unknown>;
    expect(headers.authorization).toBe(CENSURA);
    expect(headers.cookie).toBe(CENSURA);
    expect(headers['x-api-key']).toBe(CENSURA);
    expect(headers['x-signature']).toBe(CENSURA);
    // Header inócuo passa: é ele que permite depurar o request.
    expect(headers['content-type']).toBe('application/json');
    expect(req.url).toBe('/api/v1/minha-api');
  });

  it('redige set-cookie em res.headers', () => {
    const linha = logar({
      res: {
        statusCode: 200,
        headers: { 'set-cookie': 'session=abc123; HttpOnly', 'x-request-id': 'req-1' },
      },
    });
    const headers = (linha.res as Record<string, unknown>).headers as Record<string, unknown>;
    expect(headers['set-cookie']).toBe(CENSURA);
    expect(headers['x-request-id']).toBe('req-1');
  });
});

describe('redactPaths — o que NÃO é redigido (limites conhecidos)', () => {
  it('campo não sensível passa intacto (senão o log perderia utilidade)', () => {
    const linha = logar({
      email: 'pessoa@exemplo.com',
      nome: 'Fulano de Tal',
      sheetApiId: 'api-1',
      statusCode: 200,
    });
    expect(linha.email).toBe('pessoa@exemplo.com');
    expect(linha.nome).toBe('Fulano de Tal');
    expect(linha.sheetApiId).toBe('api-1');
    expect(linha.statusCode).toBe(200);
  });

  it('o curinga é de UM nível: dois níveis abaixo NÃO é redigido', () => {
    // Limitação real, não bug de teste: `*.password` cobre `a.password`, mas
    // não `a.b.password`. Quem loga objeto aninhado (ex.: erro do Prisma com
    // o registro dentro de `meta`) precisa saber disso.
    const linha = logar({ a: { b: { password: 'passa-em-texto-claro' } } });
    const b = (linha.a as Record<string, unknown>).b as Record<string, unknown>;
    expect(b.password).toBe('passa-em-texto-claro');
  });

  it('`*.bearerTokenHash`, `*.basicPassHash` e `*.keyHash` não estão na lista', () => {
    // Assimetria da lista: os três são redigidos na RAIZ mas não um nível
    // abaixo (ver logger.ts:30-33). Logar `{ sheetApi: registroDoPrisma }`
    // — o formato natural — deixa o hash bcrypt sair no log.
    const linha = logar({
      sheetApi: { bearerTokenHash: '$2b$10$hash', basicPassHash: '$2b$10$hash2', keyHash: '$2b$10$hash3' },
    });
    const sheetApi = linha.sheetApi as Record<string, unknown>;
    expect(sheetApi.bearerTokenHash).toBe('$2b$10$hash');
    expect(sheetApi.basicPassHash).toBe('$2b$10$hash2');
    expect(sheetApi.keyHash).toBe('$2b$10$hash3');
  });

  it('valor sensível dentro da MENSAGEM de texto não é tocado', () => {
    // A redação atua sobre propriedades do objeto, nunca sobre a string do
    // `msg`. Interpolar segredo na mensagem contorna toda a defesa.
    const { log, linhas } = criarLoggerEmMemoria();
    log.warn('falha ao autenticar com token abc123');
    expect((linhas[0] as LinhaDeLog).msg).toBe('falha ao autenticar com token abc123');
  });
});

describe('logger exportado', () => {
  it('usa o LOG_LEVEL do env', () => {
    expect(logger.level).toBe('debug');
  });

  it('carimba `service: sheets-banco-api` como base', () => {
    expect(logger.bindings()).toMatchObject({ service: 'sheets-banco-api' });
  });

  it('filhos herdam a base e adicionam o `component`', () => {
    const filho = logger.child({ component: 'worker:sheets-write' });
    expect(filho.bindings()).toMatchObject({
      service: 'sheets-banco-api',
      component: 'worker:sheets-write',
    });
  });

  it('a instância exportada realmente redige (não só a lista sabe redigir)', () => {
    // Troca o destino da instância real pelo símbolo público do pino, para
    // provar que o `logger` de produção foi construído COM o `redact`.
    const linhas: LinhaDeLog[] = [];
    const original = (logger as unknown as Record<symbol, unknown>)[pino.symbols.streamSym];
    (logger as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] = {
      write(linha: string) {
        linhas.push(JSON.parse(linha) as LinhaDeLog);
      },
    };
    try {
      logger.info({ cpf: '123.456.789-00', googleRefreshToken: '1//token', nome: 'Fulano' }, 'ok');
    } finally {
      (logger as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] = original;
    }

    const linha = linhas[0] as LinhaDeLog;
    expect(linha.cpf).toBe(CENSURA);
    expect(linha.googleRefreshToken).toBe(CENSURA);
    expect(linha.nome).toBe('Fulano');
  });
});
