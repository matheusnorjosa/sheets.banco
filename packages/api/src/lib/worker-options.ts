import type { WorkerOptions } from 'bullmq';

/**
 * Opções de polling aplicadas a TODO `Worker` do BullMQ.
 *
 * Existe por causa de um incidente real (2026-07-29): a cota mensal do Upstash
 * estourou — `ERR max requests limit exceeded. Limit: 500000, Usage: 500001` —
 * e derrubou toda escrita enfileirada com 500. O tráfego de uso não tinha
 * nenhuma relação com isso: o pico medido da API era de 27 req/min. Quem
 * queimou a cota foram os três workers PARADOS.
 *
 * Worker ocioso do BullMQ não fica quieto. Com os defaults:
 *
 * | opção             | default | comandos/min por worker |
 * |-------------------|---------|-------------------------|
 * | `drainDelay`      | 5 s     | ~12 (`bzpopmin` refeito)|
 * | `stalledInterval` | 30 s    | ~2 (script de stall)    |
 *
 * Três workers × ~14/min × 60 × 24 × 30 ≈ **1,8 milhão de comandos/mês**,
 * contra um teto de 500 mil. A cota ia estourar com ou sem usuário — só
 * precisava do serviço acordado, que é exatamente o que o keep-alive garante.
 *
 * ## Por que aumentar o `drainDelay` não atrasa nada
 *
 * `drainDelay` não é um `sleep`: é o **timeout** de um `bzpopmin`, que é
 * bloqueante (`worker.js:447` do bullmq). Job novo escreve na chave marcadora e
 * a chamada retorna na hora. Aumentar o valor reduz quantas vezes a chamada é
 * refeita quando a fila está vazia, e **não** adiciona latência ao job. É o que
 * torna este ajuste seguro em vez de um trade-off.
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
 * Três workers × ~2,2/min ≈ **285 mil comandos/mês** — abaixo do teto, mas com
 * folga apertada. Se voltar a apertar, a saída não é cortar mais o polling: é
 * um Redis cobrado por memória em vez de por comando (o Key Value do Render,
 * por exemplo), que remove o teto do problema em vez de conviver com ele.
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
