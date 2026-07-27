import type { SheetRow } from '../services/google-sheets.service.js';

/**
 * Evaluate computed field expressions against a row of data.
 *
 * Supports:
 * - Template strings: "{{firstName}} {{lastName}}"
 * - Math expressions: "{{price}} * {{quantity}}"
 * - Mixed: "Total: {{price}} * {{qty}}"
 */

const TEMPLATE_RE = /\{\{(\w+)\}\}/g;

/**
 * Safe math evaluator — supports +, -, *, /, parentheses, and numbers.
 * No eval() or Function() used.
 */
function safeMathEval(expr: string): number | null {
  // Only allow digits, operators, parens, dots, spaces
  const sanitized = expr.replace(/\s+/g, '');
  if (!/^[\d+\-*/().]+$/.test(sanitized)) return null;

  try {
    // Tokenize and evaluate using a simple recursive descent parser
    return parseExpression(sanitized, { pos: 0 });
  } catch {
    return null;
  }
}

interface ParseState {
  pos: number;
}

function parseExpression(expr: string, state: ParseState): number {
  let result = parseTerm(expr, state);
  while (state.pos < expr.length && (expr[state.pos] === '+' || expr[state.pos] === '-')) {
    const op = expr[state.pos++];
    const right = parseTerm(expr, state);
    result = op === '+' ? result + right : result - right;
  }
  return result;
}

function parseTerm(expr: string, state: ParseState): number {
  let result = parseFactor(expr, state);
  while (state.pos < expr.length && (expr[state.pos] === '*' || expr[state.pos] === '/')) {
    const op = expr[state.pos++];
    const right = parseFactor(expr, state);
    result = op === '*' ? result * right : result / right;
  }
  return result;
}

function parseFactor(expr: string, state: ParseState): number {
  if (expr[state.pos] === '(') {
    state.pos++; // skip '('
    const result = parseExpression(expr, state);
    state.pos++; // skip ')'
    return result;
  }

  // Handle negative numbers
  let negative = false;
  if (expr[state.pos] === '-') {
    negative = true;
    state.pos++;
  }

  const start = state.pos;
  while (state.pos < expr.length) {
    const ch = expr[state.pos] as string;
    if (!/\d/.test(ch) && ch !== '.') break;
    state.pos++;
  }
  const num = parseFloat(expr.slice(start, state.pos));
  if (isNaN(num)) throw new Error('Invalid number');
  return negative ? -num : num;
}

/**
 * A EXPRESSÃO pede aritmética?
 *
 * A pergunta é feita à expressão que a pessoa escreveu, com os placeholders
 * neutralizados — nunca ao texto já substituído. Essa distinção é o ponto todo
 * desta função.
 *
 * Antes, o `evaluateExpression` chamava o avaliador sobre a string já montada,
 * então o VALOR da célula decidia. Um campo que só repassava uma coluna
 * (`{{cpf}}`, sem operador nenhum) virava conta sempre que o conteúdo parecesse
 * uma: `012.345.678-90` saía como `-77.66`, e o código de produto `0601001`
 * perdia o zero e saía `601001` — a mesma armadilha de zero à esquerda que já
 * mordeu a migração do Protheus, agora do lado da resposta da API.
 *
 * Trocando os `{{...}}` por `0`, `{{preco}} * {{qtd}}` vira `0 * 0` (tem
 * operador, e o resto é só aritmética → é conta) enquanto `{{cpf}}` vira `0`
 * (sem operador → é texto, seja lá o que a célula contenha).
 */
function isArithmeticExpression(expression: string): boolean {
  const withoutPlaceholders = expression.replace(TEMPLATE_RE, '0');

  // Precisa de ao menos um operador — senão é repasse de valor, não cálculo.
  if (!/[+\-*/]/.test(withoutPlaceholders)) return false;

  // E o que sobra tem que ser só aritmética. Qualquer letra ou símbolo
  // (`Total: {{a}}`, `{{a-b}}`) indica texto com placeholder dentro.
  return /^[\d+\-*/().\s]+$/.test(withoutPlaceholders);
}

/**
 * Evaluate a single computed field expression for a row.
 */
export function evaluateExpression(expression: string, row: SheetRow): string {
  // Replace all {{col}} with actual values
  const substituted = expression.replace(TEMPLATE_RE, (_, col) => {
    return row[col] ?? '';
  });

  // Sem operador na expressão, o valor sai como está na planilha — inclusive
  // zero à esquerda, CPF pontuado e o que mais a célula tiver.
  if (!isArithmeticExpression(expression)) return substituted;

  const mathResult = safeMathEval(substituted);
  if (mathResult !== null && isFinite(mathResult)) {
    // Format: remove trailing zeros for clean output
    return mathResult % 1 === 0 ? String(mathResult) : mathResult.toFixed(2);
  }

  // Conta que não fecha (célula com texto, divisão por zero) devolve o texto
  // substituído, para o consumidor ver o que entrou.
  return substituted;
}

/**
 * Apply computed fields to an array of rows.
 */
export function applyComputedFields(
  rows: SheetRow[],
  fields: { name: string; expression: string }[],
): SheetRow[] {
  if (fields.length === 0) return rows;

  return rows.map((row) => {
    const extended = { ...row };
    for (const field of fields) {
      extended[field.name] = evaluateExpression(field.expression, row);
    }
    return extended;
  });
}
