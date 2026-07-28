/**
 * Erro que o SDK lança quando a API responde com falha.
 *
 * Carrega o envelope de erro inteiro — inclusive o `request_id`, que antes era
 * descartado na conversão. Ele é o que liga o problema relatado por quem
 * consome o SDK à linha de log do servidor (`docs/error-handling.md`); sem
 * ele, um chamado abre sem o id e do outro lado não há como achar a
 * requisição.
 */
export class SheetsBancoError extends Error {
  /**
   * `readonly` de propósito: nada deveria reescrever o código de um erro
   * depois de capturá-lo, senão o log conta uma história diferente da que
   * aconteceu.
   */
  readonly status: number;
  readonly code: string;
  /** `request_id` do envelope, quando a resposta trouxe um. */
  readonly requestId?: string;
  /** O corpo da resposta como veio, para diagnóstico do que o tipo não cobre. */
  readonly body?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    extras: { requestId?: string; body?: unknown } = {},
  ) {
    super(message);
    this.name = 'SheetsBancoError';
    this.status = status;
    this.code = code;
    this.requestId = extras.requestId;
    this.body = extras.body;
  }

  /**
   * Sem isto, `JSON.stringify(erro)` perde a `message`: ela mora no protótipo
   * de `Error` e não é enumerável. Muitos loggers fazem exatamente isso com um
   * objeto de erro, e o resultado era uma linha de log com o código e sem
   * dizer o que aconteceu.
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      code: this.code,
      requestId: this.requestId,
    };
  }
}

/** Falha antes de haver resposta: DNS, recusa de conexão, socket cortado. */
export class NetworkError extends SheetsBancoError {
  constructor(message: string) {
    super(0, 'NETWORK_ERROR', message);
    this.name = 'NetworkError';
  }
}

/**
 * A resposta chegou, mas não era JSON.
 *
 * Acontece de verdade: HTML de gateway (502/504 do Render ou de proxy
 * corporativo), página de manutenção, corpo truncado, corpo vazio num 500.
 * Antes, o `JSON.parse` estourava um `SyntaxError` cru — que não é
 * `SheetsBancoError`, então escapava de qualquer
 * `catch (e) { if (e instanceof SheetsBancoError) ... }` — e a mensagem
 * ('Unexpected token <') não dizia nem o status nem a URL.
 */
export class InvalidResponseError extends SheetsBancoError {
  constructor(status: number, trecho: string, extras: { body?: unknown } = {}) {
    super(
      status,
      'INVALID_RESPONSE',
      `A resposta (HTTP ${status}) não é JSON válido: ${trecho}`,
      extras,
    );
    this.name = 'InvalidResponseError';
  }
}
