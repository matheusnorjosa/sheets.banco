import type { WorkerOptions } from 'bullmq';

/**
 * Opções de polling aplicadas a TODO `Worker` do BullMQ.
 *
 * Worker ocioso do BullMQ não fica quieto. Com os defaults, cada um refaz o
 * `bzpopmin` a cada 5 s (~12 comandos/min) e roda a checagem de stall a cada
 * 30 s (~2/min). Três workers dão ordem de 1,8 milhão de comandos/mês.
 *
 * ⚠️ Estes valores nasceram de um diagnóstico que depois se mostrou ERRADO.
 * Em 2026-07-30 a cota mensal do Upstash estourou e derrubou a escrita
 * enfileirada, e eu atribuí a causa a estes workers. A aritmética desmente: a
 * 1,8 milhão/mês a cota de julho teria morrido no dia 8, e ela durou até o 30.
 * A medição de agosto fechou em ~2,4 milhões/mês no total — os workers eram
 * fração disso, e o resto (rate limiter e cache, ambos no Redis) nunca foi
 * medido por consumidor.
 *
 * O projeto saiu do Upstash em 2026-08-07 para o Key Value do Render, que cobra
 * por MEMÓRIA e não por comando. Então **estes valores não são mais
 * load-bearing**: não seguram nenhum teto. Ficam porque continuam corretos e
 * baratos, não porque algo depende deles. Quem for mexer não precisa ter medo
 * de voltar aos defaults.
 *
 * ## Por que aumentar o `drainDelay` não atrasa nada
 *
 * `drainDelay` não é um `sleep`: é o **timeout** de um `bzpopmin`, que é
 * bloqueante. Job novo escreve na chave marcadora e a chamada retorna na hora.
 * Aumentar o valor reduz quantas vezes a chamada é refeita com a fila vazia e
 * **não** adiciona latência ao job.
 *
 * No bullmq 6 o `bzpopmin` saiu do `worker.js` para a camada de cliente
 * (`ioredis-client.js`, que usa o bloqueio nativo do ioredis); quem converte
 * `drainDelay` em timeout de bloqueio é `worker.js:468`. A v6 também passou a
 * recusar `drainDelay <= 0` e a aplicar um `minimumBlockTimeout` — 30 está bem
 * acima de qualquer piso.
 *
 * 30 s dá um corte de 6× e fica numa faixa conservadora: o próprio BullMQ
 * limita a 10 s o timeout do ramo de job atrasado (issue #1658, para não
 * segurar a conexão durante reconexão), então não convém ir a minutos aqui.
 *
 * ## O `stalledInterval` é um trade-off de verdade
 *
 * A checagem de stall é o que recupera job cujo worker morreu no meio. A 5 min,
 * essa recuperação passa a levar até 5 min em vez de 30 s. Aceito: só afeta
 * queda de processo, e escrita em planilha tolera minutos. **Não** trocar por
 * `skipStalledCheck: true` — aí o job simplesmente se perde.
 *
 * Subir o intervalo acima do `lockDuration` (30 s) não gera falso positivo: o
 * lock é renovado enquanto o job processa, então job vivo nunca é visto como
 * travado.
 *
 * ## Efeito
 *
 * Três workers × ~2,2/min ≈ 285 mil comandos/mês, contra ~1,8 milhão nos
 * defaults. Corte real, mas — como está dito acima — hoje sem consequência de
 * custo, porque a cobrança passou a ser por memória.
 */
export const DEFAULT_WORKER_OPTIONS: Partial<WorkerOptions> = {
  drainDelay: 30,
  stalledInterval: 300_000,
};

/**
 * Mescla `DEFAULT_WORKER_OPTIONS` com o que o worker específico precisa —
 * `connection`, `concurrency`, `limiter`. Overrides ganham.
 *
 * Usar em todo `new Worker(...)` para que a política de polling fique num lugar
 * só. Este repo já foi mordido pelo padrão oposto: o parse da `REDIS_URL`
 * estava copiado em seis arquivos com o mesmo defeito nos seis (ver
 * `redis-connection.ts`), e o `await` faltando no rate limit estava em 11
 * pontos porque cada rota registrava do seu jeito.
 */
export function buildWorkerOptions(overrides: WorkerOptions): WorkerOptions {
  return { ...DEFAULT_WORKER_OPTIONS, ...overrides };
}
