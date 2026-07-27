/**
 * Testes de caracterização de `config/env.ts`.
 *
 * Este módulo é a única guarda que impede subir produção mal configurada: JWT
 * fraco, CORS aberto e sem chave de criptografia at-rest. Ele valida
 * `process.env` na IMPORTAÇÃO e chama `process.exit(1)` — não lança, não
 * retorna erro. Por isso nada mais no sistema avisa se alguém afrouxar o
 * `superRefine` sem querer: o processo simplesmente continua subindo.
 *
 * Técnica: cada cenário roda com `vi.resetModules()` + `vi.stubEnv` + espiões
 * em `process.exit`/`console.error` ANTES do `await import('./env.js')`. Sem o
 * reset o módulo ficaria em cache com o env do primeiro teste.
 *
 * Detalhe importante do comportamento real: com `process.exit` mockado para
 * no-op, `loadEnv()` segue adiante e devolve `result.data`, que é `undefined`
 * num parse falho. Ou seja, nos cenários de falha `env` é `undefined` — a
 * asserção que vale é o `process.exit(1)`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { argDaChamada } from '../test-utils/app.js';

/**
 * Todas as chaves lidas pelo schema. São zeradas (ou definidas) a cada cenário
 * para que o ambiente da máquina de CI/dev não vaze para dentro do teste — o
 * vitest, por exemplo, define `NODE_ENV=test`, o que mascararia o default
 * `'development'`.
 */
const CHAVES = [
  'NODE_ENV',
  'DATABASE_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'JWT_SECRET',
  'PORT',
  'HOST',
  'FRONTEND_URL',
  'ALLOWED_ORIGINS',
  'REDIS_URL',
  'LOG_LEVEL',
  'BODY_LIMIT',
  'SECRETS_ENC_KEY',
] as const;

type Chave = (typeof CHAVES)[number];
type Cenario = Partial<Record<Chave, string>>;

/** Menor ambiente que o schema aceita fora de produção. */
const BASE: Cenario = {
  DATABASE_URL: 'postgresql://user:senha@localhost:5432/banco',
  GOOGLE_CLIENT_ID: 'client-id-fake',
  GOOGLE_CLIENT_SECRET: 'client-secret-fake',
  JWT_SECRET: 'a'.repeat(16), // fronteira do `min(16)`
};

/** 64 chars hex — valor de formato válido para `SECRETS_ENC_KEY`. */
const HEX_64 = '0123456789abcdef'.repeat(4);

/** Produção mínima que PASSA nas três guardas do `superRefine`. */
const PROD: Cenario = {
  ...BASE,
  NODE_ENV: 'production',
  JWT_SECRET: 'p'.repeat(32),
  ALLOWED_ORIGINS: 'https://app.exemplo.com',
  SECRETS_ENC_KEY: HEX_64,
};

async function carregar(vars: Cenario) {
  vi.resetModules();
  for (const chave of CHAVES) {
    // `undefined` remove a variável no vitest — é assim que se testa default.
    vi.stubEnv(chave, vars[chave]);
  }
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const mod = await import('./env.js');
  return { env: mod.env, exit, erro };
}

/** Junta tudo que foi para o `console.error`, para inspecionar mensagens. */
function mensagens(erro: { mock: { calls: unknown[][] } }): string {
  return erro.mock.calls.map((_, i) => argDaChamada<string>(erro, i, 0)).join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ambiente mínimo válido', () => {
  it('importa sem chamar process.exit', async () => {
    const { exit, erro } = await carregar(BASE);
    expect(exit).not.toHaveBeenCalled();
    expect(erro).not.toHaveBeenCalled();
  });

  it('aplica os defaults documentados quando as opcionais não vêm', async () => {
    const { env } = await carregar(BASE);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      HOST: '0.0.0.0',
      FRONTEND_URL: 'http://localhost:3001',
      REDIS_URL: 'redis://localhost:6379',
      LOG_LEVEL: 'info',
      BODY_LIMIT: 1_048_576,
      GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
    });
  });

  it('deixa ALLOWED_ORIGINS e SECRETS_ENC_KEY indefinidos fora de produção', async () => {
    const { env } = await carregar(BASE);
    expect(env.ALLOWED_ORIGINS).toBeUndefined();
    expect(env.SECRETS_ENC_KEY).toBeUndefined();
  });

  it('descarta chaves de process.env que não estão no schema (strip do zod)', async () => {
    const { env } = await carregar(BASE);
    // PATH sempre existe no processo, mas não pertence ao schema.
    expect(Object.keys(env).sort()).toEqual([...CHAVES].sort().filter(
      (c) => c !== 'ALLOWED_ORIGINS' && c !== 'SECRETS_ENC_KEY',
    ));
  });
});

describe('coerção numérica', () => {
  it('converte PORT string em number', async () => {
    const { env, exit } = await carregar({ ...BASE, PORT: '8080' });
    expect(exit).not.toHaveBeenCalled();
    expect(env.PORT).toBe(8080);
    expect(typeof env.PORT).toBe('number');
  });

  it('converte BODY_LIMIT string em number', async () => {
    const { env, exit } = await carregar({ ...BASE, BODY_LIMIT: '5000' });
    expect(exit).not.toHaveBeenCalled();
    expect(env.BODY_LIMIT).toBe(5000);
    expect(typeof env.BODY_LIMIT).toBe('number');
  });

  it.each(['0', '-1'])('recusa BODY_LIMIT=%s (positive)', async (valor) => {
    const { exit } = await carregar({ ...BASE, BODY_LIMIT: valor });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('recusa BODY_LIMIT fracionário (int)', async () => {
    const { exit } = await carregar({ ...BASE, BODY_LIMIT: '1.5' });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('recusa BODY_LIMIT não numérico', async () => {
    const { exit } = await carregar({ ...BASE, BODY_LIMIT: 'muito' });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('PORT NÃO é int/positive: aceita 0 e negativo (comportamento atual)', async () => {
    const { env, exit } = await carregar({ ...BASE, PORT: '-1' });
    expect(exit).not.toHaveBeenCalled();
    expect(env.PORT).toBe(-1);
  });
});

describe('variáveis obrigatórias', () => {
  it.each<Chave>([
    'DATABASE_URL',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'JWT_SECRET',
  ])('encerra o processo quando falta %s', async (chave) => {
    const vars: Cenario = { ...BASE };
    delete vars[chave];
    const { exit } = await carregar(vars);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('encerra quando DATABASE_URL não é URL', async () => {
    const { exit } = await carregar({ ...BASE, DATABASE_URL: 'nao-e-url' });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('ACEITA DATABASE_URL sem esquema conhecido, como "localhost:5432"', async () => {
    // Comportamento real do `z.string().url()` no zod 4: basta ter um esquema
    // sintaticamente válido. `localhost:5432` vira esquema "localhost:" e passa.
    // Vale registrar: o erro de configuração mais comum (esquecer o
    // `postgresql://`) NÃO é pego aqui — quebra depois, no Prisma.
    const { env, exit } = await carregar({ ...BASE, DATABASE_URL: 'localhost:5432' });
    expect(exit).not.toHaveBeenCalled();
    expect(env.DATABASE_URL).toBe('localhost:5432');
  });

  it.each(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const)(
    'encerra quando %s é string vazia (min 1)',
    async (chave) => {
      const { exit } = await carregar({ ...BASE, [chave]: '' });
      expect(exit).toHaveBeenCalledWith(1);
    },
  );

  it('encerra quando GOOGLE_REDIRECT_URI é definido mas não é URL', async () => {
    const { exit } = await carregar({ ...BASE, GOOGLE_REDIRECT_URI: 'nao-e-url' });
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('JWT_SECRET — fronteira dos 16 chars', () => {
  it('encerra com 15 chars', async () => {
    const { exit } = await carregar({ ...BASE, JWT_SECRET: 'a'.repeat(15) });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('aceita exatamente 16 chars', async () => {
    const { env, exit } = await carregar({ ...BASE, JWT_SECRET: 'a'.repeat(16) });
    expect(exit).not.toHaveBeenCalled();
    expect(env.JWT_SECRET).toHaveLength(16);
  });
});

describe('guardas de produção — JWT_SECRET >= 32', () => {
  it('encerra em produção com 31 chars', async () => {
    const { exit, erro } = await carregar({ ...PROD, JWT_SECRET: 'p'.repeat(31) });
    expect(exit).toHaveBeenCalledWith(1);
    expect(mensagens(erro)).toContain('JWT_SECRET');
  });

  it('aceita em produção com exatamente 32 chars', async () => {
    const { exit } = await carregar({ ...PROD, JWT_SECRET: 'p'.repeat(32) });
    expect(exit).not.toHaveBeenCalled();
  });

  it('o MESMO segredo de 31 chars passa em development (guarda é só de prod)', async () => {
    const { env, exit } = await carregar({ ...BASE, JWT_SECRET: 'p'.repeat(31) });
    expect(exit).not.toHaveBeenCalled();
    expect(env.NODE_ENV).toBe('development');
  });
});

describe('guardas de produção — ALLOWED_ORIGINS', () => {
  it('encerra em produção sem ALLOWED_ORIGINS', async () => {
    const vars: Cenario = { ...PROD };
    delete vars.ALLOWED_ORIGINS;
    const { exit, erro } = await carregar(vars);
    expect(exit).toHaveBeenCalledWith(1);
    expect(mensagens(erro)).toContain('ALLOWED_ORIGINS');
  });

  it('o MESMO ambiente sem ALLOWED_ORIGINS passa em development', async () => {
    const vars: Cenario = { ...PROD, NODE_ENV: 'development' };
    delete vars.ALLOWED_ORIGINS;
    const { exit } = await carregar(vars);
    expect(exit).not.toHaveBeenCalled();
  });

  it('produção aceita quando ALLOWED_ORIGINS está preenchido', async () => {
    const { env, exit } = await carregar(PROD);
    expect(exit).not.toHaveBeenCalled();
    expect(env.ALLOWED_ORIGINS).toBe('https://app.exemplo.com');
  });

  it('ALLOWED_ORIGINS vazio conta como ausente em produção (falsy)', async () => {
    const { exit } = await carregar({ ...PROD, ALLOWED_ORIGINS: '' });
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('guardas de produção — SECRETS_ENC_KEY', () => {
  it('encerra em produção sem SECRETS_ENC_KEY', async () => {
    const vars: Cenario = { ...PROD };
    delete vars.SECRETS_ENC_KEY;
    const { exit, erro } = await carregar(vars);
    expect(exit).toHaveBeenCalledWith(1);
    expect(mensagens(erro)).toContain('SECRETS_ENC_KEY');
  });

  it('o MESMO ambiente sem SECRETS_ENC_KEY passa em development', async () => {
    const vars: Cenario = { ...PROD, NODE_ENV: 'development' };
    delete vars.SECRETS_ENC_KEY;
    const { exit } = await carregar(vars);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('formato de SECRETS_ENC_KEY (64 hex)', () => {
  it('aceita 64 hex minúsculo', async () => {
    const { env, exit } = await carregar({ ...BASE, SECRETS_ENC_KEY: HEX_64 });
    expect(exit).not.toHaveBeenCalled();
    expect(env.SECRETS_ENC_KEY).toBe(HEX_64);
  });

  it('aceita 64 hex MAIÚSCULO (a regex tem flag i)', async () => {
    const maiusculo = HEX_64.toUpperCase();
    const { env, exit } = await carregar({ ...BASE, SECRETS_ENC_KEY: maiusculo });
    expect(exit).not.toHaveBeenCalled();
    expect(env.SECRETS_ENC_KEY).toBe(maiusculo);
  });

  it('encerra com 63 chars', async () => {
    const { exit } = await carregar({ ...BASE, SECRETS_ENC_KEY: HEX_64.slice(0, 63) });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('encerra com 65 chars', async () => {
    const { exit } = await carregar({ ...BASE, SECRETS_ENC_KEY: `${HEX_64}a` });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('encerra com caractere não-hex', async () => {
    const { exit, erro } = await carregar({ ...BASE, SECRETS_ENC_KEY: `${HEX_64.slice(0, 63)}z` });
    expect(exit).toHaveBeenCalledWith(1);
    expect(mensagens(erro)).toContain('must be 64 hex chars');
  });
});

describe('enums', () => {
  it.each(['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const)(
    'aceita LOG_LEVEL=%s',
    async (nivel) => {
      const { env, exit } = await carregar({ ...BASE, LOG_LEVEL: nivel });
      expect(exit).not.toHaveBeenCalled();
      expect(env.LOG_LEVEL).toBe(nivel);
    },
  );

  it('encerra com LOG_LEVEL fora do enum', async () => {
    const { exit, erro } = await carregar({ ...BASE, LOG_LEVEL: 'verbose' });
    expect(exit).toHaveBeenCalledWith(1);
    expect(mensagens(erro)).toContain('LOG_LEVEL');
  });

  it.each(['development', 'test', 'production'] as const)('aceita NODE_ENV=%s', async (modo) => {
    const vars: Cenario = modo === 'production' ? PROD : { ...BASE, NODE_ENV: modo };
    const { env, exit } = await carregar(vars);
    expect(exit).not.toHaveBeenCalled();
    expect(env.NODE_ENV).toBe(modo);
  });

  it('encerra com NODE_ENV fora do enum (ex.: staging)', async () => {
    const { exit, erro } = await carregar({ ...BASE, NODE_ENV: 'staging' });
    expect(exit).toHaveBeenCalledWith(1);
    expect(mensagens(erro)).toContain('NODE_ENV');
  });

  it('NODE_ENV inválido NÃO dispara as guardas de produção', async () => {
    // O superRefine só roda com NODE_ENV === 'production'; com 'staging' o enum
    // já falhou e o refinamento nem chega a ser avaliado.
    const { exit, erro } = await carregar({ ...BASE, NODE_ENV: 'staging' });
    expect(exit).toHaveBeenCalledWith(1);
    expect(mensagens(erro)).not.toContain('ALLOWED_ORIGINS');
    expect(mensagens(erro)).not.toContain('SECRETS_ENC_KEY');
  });
});

describe('diagnóstico impresso', () => {
  it('imprime o cabeçalho e uma linha "CAMPO: mensagem" por problema', async () => {
    const vars: Cenario = { ...BASE };
    delete vars.JWT_SECRET;
    const { erro } = await carregar(vars);

    expect(argDaChamada<string>(erro, 0, 0)).toContain('Invalid environment variables');
    expect(mensagens(erro)).toMatch(/JWT_SECRET: .+/);
  });

  it('lista TODOS os campos que falharam, não só o primeiro', async () => {
    const { erro } = await carregar({
      DATABASE_URL: 'nao-e-url',
      JWT_SECRET: 'curto',
    });
    const saida = mensagens(erro);
    expect(saida).toContain('DATABASE_URL');
    expect(saida).toContain('GOOGLE_CLIENT_ID');
    expect(saida).toContain('GOOGLE_CLIENT_SECRET');
    expect(saida).toContain('JWT_SECRET');
  });

  it('em produção nomeia as três guardas de uma vez', async () => {
    const { exit, erro } = await carregar({
      ...BASE,
      NODE_ENV: 'production',
      JWT_SECRET: 'curto-mas-com-16c',
    });
    const saida = mensagens(erro);
    expect(exit).toHaveBeenCalledWith(1);
    expect(saida).toContain('JWT_SECRET');
    expect(saida).toContain('ALLOWED_ORIGINS');
    expect(saida).toContain('SECRETS_ENC_KEY');
  });
});
