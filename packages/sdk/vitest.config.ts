import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // `all: true` pelo mesmo motivo do `packages/api`: sem ele o v8 mede
      // apenas os arquivos que algum teste importou, e arquivo sem teste
      // nenhum simplesmente não aparece no relatório — o número sobe
      // justamente por causa do que falta testar.
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text-summary', 'json-summary'],
      // Catraca inicial: o pacote entrou em 100%%, e não há motivo para deixar
      // cair. Arquivo novo sem teste derruba o número e o CI acusa — que é
      // exatamente o serviço que se espera daqui. A regra é a mesma do
      // `packages/api`: subir quando a cobertura sobe, nunca baixar para o
      // build passar.
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
      // Sem `thresholds` de propósito: este pacote está saindo do zero e a
      // catraca inicial é definida depois de ver o número real.
    },
  },
});
