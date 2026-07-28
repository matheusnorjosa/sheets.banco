/**
 * Propósito declarado de cada JWT que esta API assina.
 *
 * Existe porque todos saem do MESMO `JWT_SECRET`: sem um claim que os
 * distinga, `request.jwtVerify()` aceita qualquer um em qualquer rota — ele só
 * confere assinatura e validade.
 *
 * Foi exatamente assim que o `tempToken` do 2FA passou a valer como sessão
 * completa. Ele é emitido em `POST /auth/login` ANTES da verificação do TOTP,
 * para quem só provou a senha; como o `jwtAuth` não olhava nada além da
 * assinatura, esse token autenticava todo `/dashboard/*` por cinco minutos.
 * Tempo de sobra para emitir uma ApiKey permanente. O segundo fator não
 * protegia nada.
 *
 * Regra desde então: **só `session` autentica requisição.** Todo token de
 * etapa intermediária ganha propósito próprio e é recusado pelo `jwtAuth`.
 * Ao criar um novo tipo de token, acrescente-o aqui — não reaproveite
 * `session`.
 */
export const JWT_PURPOSE = {
  /** Sessão do dashboard. O único que o `jwtAuth` aceita. */
  SESSION: 'session',
  /**
   * Emitido no login quando a conta tem TOTP e ele ainda não foi conferido.
   * Só vale em `POST /auth/2fa/validate`, que o troca por um de sessão.
   */
  PENDING_2FA: '2fa_pending',
} as const;

export type JwtPurpose = (typeof JWT_PURPOSE)[keyof typeof JWT_PURPOSE];

/** O que os nossos JWTs carregam, na parte que o `jwtAuth` precisa inspecionar. */
export interface JwtPayload {
  sub: string;
  email: string;
  purpose?: string;
  /**
   * Claim legado do token de 2FA, anterior ao `purpose`. Continua sendo
   * emitido e conferido porque `POST /auth/2fa/validate` o exige — trocar os
   * dois lados de uma vez invalidaria qualquer login parado na tela do TOTP
   * no instante do deploy.
   */
  pending2fa?: boolean;
}

/**
 * Este payload já verificado pode autenticar uma requisição?
 *
 * `purpose` ausente conta como sessão, de propósito: os tokens em circulação
 * no momento do deploy foram assinados sem o claim, e recusá-los aqui
 * deslogaria todo mundo no merge em vez de na rotação do segredo. Isso não
 * reabre a falha — o token de 2FA é barrado pelo `pending2fa`, que ele sempre
 * carregou.
 */
export function ehTokenDeSessao(payload: JwtPayload): boolean {
  if (payload.pending2fa === true) return false;
  if (payload.purpose !== undefined && payload.purpose !== JWT_PURPOSE.SESSION) return false;
  return true;
}
