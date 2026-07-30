export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    /**
     * Optional structured payload that the global error handler will surface
     * to clients alongside the standard fields. Use this for actionable
     * context like `enable_url` for `accessNotConfigured`.
     */
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed') {
    super(400, 'VALIDATION_ERROR', message);
    this.name = 'ValidationError';
  }
}

export class SheetAccessError extends AppError {
  constructor(message = 'Could not access the Google Sheet. Ensure it is shared with the service account.') {
    super(403, 'SHEET_ACCESS_ERROR', message);
    this.name = 'SheetAccessError';
  }
}

/**
 * A fila de escrita está indisponível — Redis fora, sem cota ou não
 * configurado.
 *
 * 503 e não 500 porque a causa é infraestrutura temporária, e principalmente
 * porque **existe uma saída imediata**: `?sync=true` grava direto no Google sem
 * passar pela fila. Em 2026-07-29 a cota do Upstash estourou e toda escrita
 * enfileirada passou a responder `500 INTERNAL_ERROR`, o que fez um consumidor
 * concluir que a API não conseguia mais gravar. Conseguia — só não pela rota
 * que ele estava usando. A mensagem carrega a alternativa para que o próximo
 * não perca esse tempo.
 */
export class QueueUnavailableError extends AppError {
  /**
   * @param saida Query param que contorna a fila, sem o `?` — hoje só
   * `sync=true`, na escrita de planilha. Omitir quando não houver saída: a fila
   * de webhook e a de sync agendado não têm equivalente, e oferecer
   * `?sync=true` ali mandaria quem leu para um caminho que não existe. Errar
   * essa mensagem é o defeito que este erro existe para corrigir.
   */
  constructor(saida?: string) {
    super(
      503,
      'QUEUE_UNAVAILABLE',
      saida
        ? `The write queue is unavailable. Retry the same request with ?${saida} to write directly, bypassing the queue.`
        : 'The queue is temporarily unavailable. Try again shortly.',
      saida ? { retry_with: saida } : undefined,
    );
    this.name = 'QueueUnavailableError';
  }
}
