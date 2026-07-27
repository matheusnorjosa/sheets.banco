/**
 * Importa, com o Node de verdade, todo módulo compilado em `dist/src`.
 *
 * Por que isto existe: `tsc`, `eslint` e `vitest` NÃO provam que um import
 * funciona em produção. O vitest roda sobre o Vite, que faz interop de
 * CommonJS por conta própria e aceita `import { x } from 'pacote-cjs'`. O Node
 * em ESM nativo não aceita: ele depende do `cjs-module-lexer` para descobrir os
 * nomes exportados, e quando o pacote termina com `module.exports = <objeto
 * montado em runtime>` o lexer não enxerga nada.
 *
 * Resultado: build verde, testes verdes, typecheck verde — e o processo morre
 * no boot com `SyntaxError: Named export '...' not found`. Foi exatamente o que
 * derrubou o deploy do `cron-parser`. Nada no CI pegava, porque nada no CI
 * chegava a executar o código compilado.
 *
 * Este script fecha essa lacuna sem precisar subir servidor: importar o módulo
 * já força o Node a resolver todos os imports estáticos dele.
 *
 * `src/index.js` fica de fora de propósito — ele chama `start()` no topo, que
 * abre porta e conecta no Postgres. Todo o resto (rotas, serviços, workers,
 * filas, middlewares, plugins) só define coisas ao ser importado.
 */
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// `config/env.ts` valida na importação e chama `process.exit(1)` se faltar
// variável. Valores fictícios: nada aqui conecta em lugar nenhum.
Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://verificacao:verificacao@localhost:5432/verificacao',
  GOOGLE_CLIENT_ID: 'verificacao',
  GOOGLE_CLIENT_SECRET: 'verificacao',
  JWT_SECRET: 'segredo-de-verificacao-com-tamanho-suficiente',
});

const RAIZ = new URL('../dist/src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const IGNORAR = new Set(['index.js']);

async function listar(dir) {
  const encontrados = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const caminho = join(dir, item.name);
    if (item.isDirectory()) {
      encontrados.push(...(await listar(caminho)));
    } else if (
      item.name.endsWith('.js') &&
      // O `tsc` também emite os `*.test.ts` para o `dist` (o tsconfig inclui
      // `src/**/*`, e o typecheck precisa deles). Importar teste fora do
      // vitest sempre falha — não é o que este script procura.
      !item.name.endsWith('.test.js') &&
      !IGNORAR.has(relative(RAIZ, caminho))
    ) {
      encontrados.push(caminho);
    }
  }
  return encontrados;
}

const modulos = await listar(RAIZ);
const falhas = [];

for (const modulo of modulos) {
  try {
    await import(pathToFileURL(modulo).href);
  } catch (erro) {
    falhas.push({ modulo: relative(RAIZ, modulo), erro: erro.message });
  }
}

if (falhas.length > 0) {
  console.error(`\n✖ ${falhas.length} de ${modulos.length} módulos não importam no Node:\n`);
  for (const { modulo, erro } of falhas) console.error(`  ${modulo}\n    ${erro}\n`);
  process.exit(1);
}

console.log(`✔ ${modulos.length} módulos importam corretamente no Node ESM.`);
