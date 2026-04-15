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
  while (state.pos < expr.length && (/\d/.test(expr[state.pos]) || expr[state.pos] === '.')) {
    state.pos++;
  }
  const num = parseFloat(expr.slice(start, state.pos));
  if (isNaN(num)) throw new Error('Invalid number');
  return negative ? -num : num;
}

/**
 * Evaluate a single computed field expression for a row.
 */
export function evaluateExpression(expression: string, row: SheetRow): string {
  // Replace all {{col}} with actual values
  const substituted = expression.replace(TEMPLATE_RE, (_, col) => {
    return row[col] ?? '';
  });

  // Check if the result is a pure math expression
  const mathResult = safeMathEval(substituted);
  if (mathResult !== null && isFinite(mathResult)) {
    // Format: remove trailing zeros for clean output
    return mathResult % 1 === 0 ? String(mathResult) : mathResult.toFixed(2);
  }

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
