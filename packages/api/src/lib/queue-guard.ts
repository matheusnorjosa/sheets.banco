import { QueueUnavailableError } from './errors.js';
import { logger } from './logger.js';

const log = logger.child({ component: 'queue-guard' });

/**
 * Nomes de erro que o ioredis usa para falha de infraestrutura.
 *
 * - `ReplyError` — o servidor respondeu recusando. É o caso da cota estourada
 *   (`ERR max requests limit exceeded`), de `NOAUTH`, `OOM` e `max number of
 *   clients`. Qualquer recusa vinda do servidor num `add()` é indisponibilidade,
 *   não erro de programação nossa — por isso o nome basta, sem casar mensagem.
 * - `AbortError` — comando abortado porque a conexão fechou com comandos
 *   pendentes. É o que aparece quando o Redis cai no meio do enfileiramento.
 * - `MaxRetriesPerRequestError` — o ioredis desistiu de reconectar.
 */
const NOMES_DE_INFRA = new Set([
  'ReplyError',
  'AbortError',
  'MaxRetriesPerRequestError',
  'ClusterAllFailedError',
]);

/** Códigos de erro de socket. */
const CODIGOS_DE_CONEXAO = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN',
]);

/**
 * Mensagens de falha de infra que NÃO vêm com nome nem código úteis.
 *
 * A primeira é nossa: `getSheetsWriteQueue()` lança `Error` cru quando a fila
 * não foi inicializada, o que acontece quando a `REDIS_URL` não está
 * configurada. Sem Redis não há fila — é indisponibilidade, não bug.
 */
const MENSAGENS_DE_INFRA = [
  /queue not initialized/i,
  /connection is closed/i,
  /stream isn't writeable/i,
  /connection timeout/i,
];

/**
 * Decide se a falha é "a fila está fora" (→ 503) ou um defeito nosso (→ 500).
 *
 * A classificação é explícita, com rethrow no default, de propósito: converter
 * qualquer exceção em 503 esconderia bug de payload atrás de uma mensagem de
 * indisponibilidade, e "tente com ?sync=true" não conserta código errado.
 *
 * Percorre a cadeia de `cause` porque o BullMQ e o ioredis embrulham o erro
 * original em algumas versões — checar só a camada de cima deixa passar.
 */
export function ehFalhaDeInfra(erro: unknown, profundidade = 0): boolean {
  if (!(erro instanceof Error) || profundidade > 3) return false;

  if (NOMES_DE_INFRA.has(erro.name)) return true;

  const codigo = (erro as { code?: unknown }).code;
  if (typeof codigo === 'string' && CODIGOS_DE_CONEXAO.has(codigo)) return true;

  if (MENSAGENS_DE_INFRA.some((padrao) => padrao.test(erro.message))) return true;

  return ehFalhaDeInfra(erro.cause, profundidade + 1);
}

/**
 * Envolve um enfileiramento para que fila fora responda **503 com a saída**, em
 * vez de 500 mudo.
 *
 * Existe por causa do incidente de 2026-07-29: a cota do Upstash estourou e
 * todo `PATCH`/`POST` sem `?sync=true` passou a responder `500 INTERNAL_ERROR`.
 * A leitura continuou em 200 porque o cache engole erro de Redis em silêncio
 * (`cache.service.ts`) e cai para o Google. Só a escrita quebrava dura, e o
 * 500 genérico não dizia que `?sync=true` funcionaria na hora — então a
 * conclusão de fora foi "a API não grava mais", que era falso.
 *
 * O erro original vai para o log com stack: degradar a resposta não pode custar
 * o diagnóstico.
 */
export async function comFilaDisponivel<T>(
  fila: string,
  operacao: () => Promise<T>,
  /**
   * Query param que contorna esta fila, sem o `?`. Só a escrita de planilha tem
   * um (`sync=true`); webhook e sync agendado não, e nesses a resposta não deve
   * prometer saída que não existe.
   */
  saida?: string,
): Promise<T> {
  try {
    return await operacao();
  } catch (erro) {
    if (!ehFalhaDeInfra(erro)) throw erro;

    log.error({ err: erro, fila }, 'Fila indisponível — respondendo 503');
    throw new QueueUnavailableError(saida);
  }
}
