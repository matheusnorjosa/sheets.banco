import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Standalone pino logger for code paths outside the Fastify request lifecycle
 * (BullMQ workers, batch flushers, shutdown hooks). Fastify itself logs via
 * `app.log` — use that inside handlers. This logger exists so workers don't
 * fall back to `console.*`, which bypasses the structured JSON stream and
 * makes log filtering in production impossible.
 *
 * Children identify themselves with a `component` tag (e.g.
 * `logger.child({ component: 'worker:sheets-write' })`) so log queries like
 * `component:"worker:webhook-delivery" level:50` work without grep gymnastics.
 */
/**
 * Paths pino redacts from every log line — used by this standalone logger and
 * by the Fastify request logger in index.ts. Defense-in-depth: keeps
 * credentials/PII out of the log stream even if an error or job payload carries
 * them. Non-matching paths are ignored; secrets are still primarily protected
 * at the storage layer (secret-cipher, bcrypt).
 */
export const redactPaths = [
  // request headers that carry credentials
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-signature"]',
  'res.headers["set-cookie"]',
  // secrets & PII — top level and one level deep
  'password', 'passwordHash', 'hmacSecret', 'secret', 'bearerToken', 'bearerTokenHash',
  'basicPass', 'basicPassHash', 'keyHash', 'googleAccessToken', 'googleRefreshToken', 'cpf',
  // A lista de curingas tem que espelhar a de raiz. `bearerTokenHash`,
  // `basicPassHash` e `keyHash` estavam so na raiz: logar um registro do
  // Prisma um nivel abaixo (`{ api: { bearerTokenHash } }`, que e o formato
  // natural de `log.info({ api }, ...)`) vazava o hash.
  '*.password', '*.passwordHash', '*.hmacSecret', '*.secret', '*.bearerToken',
  '*.bearerTokenHash', '*.basicPass', '*.basicPassHash', '*.keyHash',
  '*.googleAccessToken', '*.googleRefreshToken', '*.cpf',
];

/**
 * Parâmetros de query cujo VALOR nunca pode ir para o log.
 *
 * `redactPaths` não alcança isto: ele redige campos de OBJETO, e a query vive
 * dentro de uma string (`req.url`). O serializador padrão do Fastify registra
 * `url` inteira, com query, em toda requisição — e em `LOG_LEVEL=info`, que é o
 * padrão de produção.
 *
 * O caso concreto: `GET /auth/google?token=<JWT>`. O dashboard manda o próprio
 * token de sessão na query porque é navegação de topo do navegador, onde não há
 * como pôr header. Isso gravava um JWT de 24h legível no log da API.
 *
 * `code` está na lista por causa do `/auth/google/callback?code=` — é o código
 * de autorização do Google, trocável por access/refresh token.
 */
const PARAMS_SENSIVEIS = new Set([
  'token',
  'temptoken',
  'access_token',
  'refresh_token',
  'id_token',
  'code',
  'key',
  'api_key',
  'apikey',
  'password',
  'secret',
  'signature',
]);

/**
 * Troca o valor dos parâmetros sensíveis por `[REDACTED]`, preservando o resto
 * da URL.
 *
 * Redigir só o que é segredo, em vez de cortar a query inteira, mantém o log
 * útil: `?sheet=GESTÃO ESCOLAR`, `?days=7` e `?layout=raw` são exatamente o que
 * se olha para entender um problema relatado.
 */
export function sanitizarUrl(url: string): string {
  const corte = url.indexOf('?');
  if (corte === -1) return url;

  const caminho = url.slice(0, corte);
  const params = new URLSearchParams(url.slice(corte + 1));

  let redigiu = false;
  for (const chave of [...params.keys()]) {
    if (PARAMS_SENSIVEIS.has(chave.toLowerCase())) {
      params.set(chave, '[REDACTED]');
      redigiu = true;
    }
  }

  // Sem nada a redigir, devolve a original: `params.toString()` re-codifica
  // (espaço vira `+`, acento vira percent-encoding) e não vale mudar como a URL
  // aparece no log de toda requisição por causa de um caso raro.
  if (!redigiu) return url;

  return `${caminho}?${params.toString()}`;
}

/** O que o serializador precisa da requisição — evita acoplar este módulo ao Fastify. */
interface RequisicaoLogavel {
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
}

/**
 * Serializadores de log da casa.
 *
 * `req` reproduz o padrão do Fastify (`lib/logger-pino.js`) campo a campo, com
 * a URL passando por `sanitizarUrl`. A cópia é deliberada: substituir o
 * serializador é tudo-ou-nada, e omitir um campo aqui apagaria em silêncio
 * `method`, `host` ou `remoteAddress` de toda linha de log — quebrando consulta
 * de log existente sem quebrar nenhum teste. Ao subir o Fastify, conferir se
 * ele passou a registrar algo novo.
 */
export const serializadoresDeLog = {
  req(req: RequisicaoLogavel) {
    // O Fastify devolve `req.headers['accept-version']` cru neste campo, mas o
    // tipo do serializador promete `string | undefined`. Um header duplicado
    // chega como array e furaria a promessa — daí a checagem em vez de um cast.
    const versao = req.headers?.['accept-version'];

    return {
      method: req.method,
      url: req.url ? sanitizarUrl(req.url) : req.url,
      version: typeof versao === 'string' ? versao : undefined,
      host: req.host,
      remoteAddress: req.ip,
      remotePort: req.socket?.remotePort,
    };
  },
};

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'sheets-banco-api' },
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  serializers: serializadoresDeLog,
});
