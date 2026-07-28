/**
 * Converte a `REDIS_URL` na opção `connection` que o BullMQ espera.
 *
 * Existe porque esse parse estava copiado em seis arquivos — três filas e três
 * workers — com o mesmo defeito nos seis:
 *
 * **1. A senha ia percent-encoded.** `new URL('redis://:a%40b@host').password`
 * devolve `'a%40b'`, não `'a@b'`. E `@`, `:`, `/` e `#` OBRIGAM encoding numa
 * URL — são exatamente os caracteres que um gerador de senha usa. O ioredis
 * recebia a senha escapada e a autenticação falhava com `NOAUTH`, sem pista no
 * log de que o problema era o parse.
 *
 * **2. `rediss://` era descartado.** O esquema sumia e nenhuma opção `tls` ia
 * para o BullMQ, então uma URL TLS (o padrão do Upstash) viraria conexão em
 * texto claro contra um endpoint que só fala TLS. Não mordeu até hoje porque a
 * `REDIS_URL` em produção é `redis://`, mas a próxima pessoa que colar uma URL
 * do Upstash levaria um erro de conexão sem explicação.
 */
export interface ConexaoRedis {
  host: string;
  port: number;
  password?: string;
  username?: string;
  tls?: Record<string, never>;
}

export function conexaoRedisDe(redisUrl: string): ConexaoRedis {
  const url = new URL(redisUrl);

  const conexao: ConexaoRedis = {
    host: url.hostname,
    port: Number(url.port) || 6379,
  };

  // `decodeURIComponent`, não `url.password` cru — ver o item 1 acima.
  if (url.password) conexao.password = decodeURIComponent(url.password);
  // O Upstash e o Redis 6+ com ACL usam usuário nomeado; ignorá-lo autentica
  // como `default`, que pode não ter as permissões da fila.
  if (url.username) conexao.username = decodeURIComponent(url.username);
  // `rediss://` é o esquema TLS. O objeto vazio basta: o ioredis usa os
  // certificados raiz do sistema, que é o que Upstash e Render esperam.
  if (url.protocol === 'rediss:') conexao.tls = {};

  return conexao;
}
