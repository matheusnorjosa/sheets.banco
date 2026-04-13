import type { SheetRow } from '../services/google-sheets.service.js';

/**
 * Fisher-Yates shuffle for random sort order.
 */
function shuffle<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export interface PaginationOptions {
  limit?: number;
  offset?: number;
  sort_by?: string;
  sort_order?: 'asc' | 'desc' | 'random';
  cast_numbers?: boolean;
}

/**
 * Sort, paginate, and optionally cast numeric values.
 */
export function applyPagination(
  rows: SheetRow[],
  options: PaginationOptions,
): SheetRow[] {
  let result = [...rows];

  // Sort
  if (options.sort_order === 'random') {
    result = shuffle(result);
  } else if (options.sort_by) {
    const key = options.sort_by;
    const dir = options.sort_order === 'desc' ? -1 : 1;

    result.sort((a, b) => {
      const aVal = a[key] ?? '';
      const bVal = b[key] ?? '';

      if (options.cast_numbers) {
        const aNum = Number(aVal);
        const bNum = Number(bVal);
        if (!isNaN(aNum) && !isNaN(bNum)) {
          return (aNum - bNum) * dir;
        }
      }

      return aVal.localeCompare(bVal) * dir;
    });
  }

  // Offset
  if (options.offset && options.offset > 0) {
    result = result.slice(options.offset);
  }

  // Limit
  if (options.limit && options.limit > 0) {
    result = result.slice(0, options.limit);
  }

  return result;
}

/**
 * Cast all numeric-looking string values to numbers in rows.
 */
export function castNumbers(rows: SheetRow[]): Record<string, string | number>[] {
  return rows.map((row) => {
    const casted: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(row)) {
      const num = Number(value);
      casted[key] = value !== '' && !isNaN(num) ? num : value;
    }
    return casted;
  });
}
