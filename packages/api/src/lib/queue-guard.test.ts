import { describe, it, expect, vi, beforeEach } from 'vitest';

const erroLogado = vi.fn();
vi.mock('./logger.js', () => ({
  logger: { child: () => ({ error: erroLogado }) },
}));

// Import dinâmico depois dos mocks — mesmo padrão do resto do repo, e aqui é
// obrigatório: `import` estático é içado acima do `const` e daria TDZ.
const { comFilaDisponivel, ehFalhaDeInfra } = await import('./queue-guard.js');
const { QueueUnavailableError, ValidationError } = await import('./errors.js');

/** Erro do ioredis quando o servidor recusa: cota, NOAUTH, OOM. */
function replyError(mensagem: string): Error {
  const erro = new Error(mensagem);
  erro.name = 'ReplyError';
  return erro;
}

function erroComCodigo(codigo: string): Error {
  return Object.assign(new Error('socket morreu'), { code: codigo });
}

beforeEach(() => {
  erroLogado.mockClear();
});

describe('ehFalhaDeInfra', () => {
  it('reconhece a cota estourada do Upstash pelo nome do erro', () => {
    // A mensagem exata do incidente de 2026-07-29. Casa por NOME (`ReplyError`)
    // e não pela mensagem, de propósito: qualquer recusa vinda do servidor num
    // enfileiramento é indisponibilidade, inclusive as que a Upstash ainda não
    // escreveu.
    expect(
      ehFalhaDeInfra(
        replyError('ERR max requests limit exceeded. Limit: 500000, Usage: 500001'),
      ),
    ).toBe(true);
  });

  it.each(['NOAUTH Authentication required', 'OOM command not allowed', 'ERR max number of clients reached'])(
    'reconhece outra recusa do servidor: %s',
    (mensagem) => {
      expect(ehFalhaDeInfra(replyError(mensagem))).toBe(true);
    },
  );

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'EAI_AGAIN'])(
    'reconhece erro de socket %s',
    (codigo) => {
      expect(ehFalhaDeInfra(erroComCodigo(codigo))).toBe(true);
    },
  );

  it('reconhece fila não inicializada — é o caso de REDIS_URL ausente', () => {
    // `getSheetsWriteQueue()` lança `Error` cru, sem nome nem código. Sem Redis
    // não existe fila: indisponibilidade, não bug.
    expect(ehFalhaDeInfra(new Error('Sheets write queue not initialized'))).toBe(true);
    expect(ehFalhaDeInfra(new Error('Webhook delivery queue not initialized'))).toBe(true);
    expect(ehFalhaDeInfra(new Error('Scheduled sync queue not initialized'))).toBe(true);
  });

  it('atravessa a cadeia de cause — BullMQ e ioredis embrulham o original', () => {
    const dentro = replyError('ERR max requests limit exceeded');
    const fora = new Error('falhou ao adicionar job', { cause: new Error('meio', { cause: dentro }) });
    expect(ehFalhaDeInfra(fora)).toBe(true);
  });

  it('para de descer a cadeia depois de 3 níveis', () => {
    // Guarda contra cause circular ou cadeia patológica. Consequência aceita:
    // infra enterrada mais fundo que isso sai como 500.
    let erro = replyError('ERR max requests limit exceeded');
    for (let i = 0; i < 5; i++) erro = new Error(`nível ${i}`, { cause: erro });
    expect(ehFalhaDeInfra(erro)).toBe(false);
  });

  it('NÃO classifica erro comum como infra', () => {
    // Este é o ponto da lista explícita: converter qualquer exceção em 503
    // esconderia bug de payload atrás de "a fila está fora", e sugerir
    // `?sync=true` não conserta código errado.
    expect(ehFalhaDeInfra(new Error('cannot read property of undefined'))).toBe(false);
    expect(ehFalhaDeInfra(new TypeError('x is not a function'))).toBe(false);
    expect(ehFalhaDeInfra(new ValidationError('campo faltando'))).toBe(false);
  });

  it('NÃO explode com valor que não é Error', () => {
    expect(ehFalhaDeInfra(undefined)).toBe(false);
    expect(ehFalhaDeInfra(null)).toBe(false);
    expect(ehFalhaDeInfra('string solta')).toBe(false);
    expect(ehFalhaDeInfra({ message: 'objeto cru' })).toBe(false);
  });
});

describe('comFilaDisponivel', () => {
  it('devolve o valor quando dá tudo certo, sem logar nada', async () => {
    await expect(comFilaDisponivel('sheets-write', async () => 'job-42')).resolves.toBe('job-42');
    expect(erroLogado).not.toHaveBeenCalled();
  });

  it('converte falha de infra em 503 com a saída na mensagem', async () => {
    const erro = await comFilaDisponivel(
      'sheets-write',
      async () => {
        throw replyError('ERR max requests limit exceeded. Limit: 500000, Usage: 500001');
      },
      'sync=true',
    ).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(QueueUnavailableError);
    const app = erro as InstanceType<typeof QueueUnavailableError>;
    expect(app.statusCode).toBe(503);
    expect(app.code).toBe('QUEUE_UNAVAILABLE');
    expect(app.message).toContain('?sync=true');
    expect(app.details).toEqual({ retry_with: 'sync=true' });
  });

  it('sem saída informada, NÃO promete alternativa que não existe', async () => {
    // Webhook e sync agendado não têm equivalente de `?sync=true`. Oferecer o
    // param ali mandaria quem leu tentar um caminho inexistente — que é o mesmo
    // tipo de erro de mensagem que este PR está corrigindo, só invertido.
    const erro = await comFilaDisponivel('webhook-delivery', async () => {
      throw replyError('ERR max requests limit exceeded');
    }).catch((e: unknown) => e);

    const app = erro as InstanceType<typeof QueueUnavailableError>;
    expect(app.statusCode).toBe(503);
    expect(app.code).toBe('QUEUE_UNAVAILABLE');
    expect(app.message).not.toContain('sync=true');
    expect(app.details).toBeUndefined();
  });

  it('loga o erro ORIGINAL com stack — degradar não pode custar o diagnóstico', async () => {
    const original = replyError('ERR max requests limit exceeded');
    await comFilaDisponivel('webhook-delivery', async () => {
      throw original;
    }).catch(() => {});

    expect(erroLogado).toHaveBeenCalledTimes(1);
    const [contexto] = erroLogado.mock.calls[0] as [{ err: unknown; fila: string }];
    // O erro que vai para o log é o de verdade, não o 503 genérico — senão a
    // resposta melhora e o log piora.
    expect(contexto.err).toBe(original);
    expect(contexto.fila).toBe('webhook-delivery');
  });

  it('repassa erro que não é de infra sem mexer', async () => {
    const bug = new TypeError('data.map is not a function');
    await expect(comFilaDisponivel('sheets-write', async () => {
      throw bug;
    })).rejects.toBe(bug);
    expect(erroLogado).not.toHaveBeenCalled();
  });

  it('não embrulha duas vezes quando um guarda chama outro', async () => {
    // `updateSyncSchedule` chama `removeSyncSchedule`, e as duas passam pelo
    // guarda. O 503 de dentro tem que subir intacto em vez de virar um 500 por
    // não ser "de infra" na visão do guarda de fora.
    const externo = await comFilaDisponivel('scheduled-sync', async () =>
      comFilaDisponivel('scheduled-sync', async () => {
        throw replyError('ERR max requests limit exceeded');
      }),
    ).catch((e: unknown) => e);

    expect(externo).toBeInstanceOf(QueueUnavailableError);
    expect((externo as { statusCode: number }).statusCode).toBe(503);
    expect(erroLogado).toHaveBeenCalledTimes(1);
  });
});
