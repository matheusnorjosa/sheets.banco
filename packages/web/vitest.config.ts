import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // O Next resolve `@/...` pelo `paths` do tsconfig; o vitest não lê isso
    // sozinho. Sem este alias, qualquer teste que importe um módulo que use
    // `@/lib/...` quebra na resolução, e não por causa do que está sendo
    // testado.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    // `node`, não `jsdom`: aqui só entra lógica pura. Módulo que toca em
    // `window`/`localStorage` é testado com dublê explícito (`vi.stubGlobal`),
    // o que deixa visível no teste qual global está em jogo — um ambiente de
    // browser inteiro esconderia isso e ainda faria o teste de SSR
    // (`typeof window === 'undefined'`) virar impossível.
    environment: 'node',
    coverage: {
      provider: 'v8',
      // O ponto central desta config é NÃO deixar o v8 medir só o arquivo que
      // algum teste importou — nesse modo o percentual sobe justamente por
      // causa do que falta testar.
      //
      // No vitest 3 isso era `all: true`. No vitest 4 a opção não existe mais
      // (o tipo `CoverageOptions` a rejeita, e o `tsc` do `next build` derruba
      // o CI por causa dela): declarar `coverage.include` já faz TODO arquivo
      // que casa com o padrão entrar no relatório, importado ou não.
      // Verificado neste pacote: um `.ts` que nenhum teste importa aparece com
      // 0%, e a cobertura total cai na hora.
      //
      // Só `.ts`: os `.tsx` são componentes React e estão fora do escopo
      // decidido (nada de render). Incluí-los aqui misturaria "não testado" com
      // "fora de escopo" no mesmo número.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text-summary', 'json-summary'],
      // Catraca inicial: o pacote entrou em 100%%, e não há motivo para deixar
      // cair. Arquivo novo sem teste derruba o número e o CI acusa — que é
      // exatamente o serviço que se espera daqui. A regra é a mesma do
      // `packages/api`: subir quando a cobertura sobe, nunca baixar para o
      // build passar.
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
