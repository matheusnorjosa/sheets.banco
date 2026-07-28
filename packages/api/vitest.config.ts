import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // `all: true` é o ponto central desta config. Sem ele o v8 mede apenas
      // os arquivos que algum teste importou — o que dava 82,8% quando a
      // cobertura real era 41,3%. Arquivo sem nenhum teste não aparecia no
      // relatório, então o número subia justamente por causa do que faltava
      // testar.
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/types/**'],
      reporter: ['text-summary', 'json-summary'],
      // Catraca: os limites estão no patamar de HOJE, não numa meta. A regra é
      // subir estes números quando a cobertura sobe, e nunca baixá-los para o
      // build passar. Serve para impedir regressão, não para premiar.
      thresholds: {
        statements: 76,
        branches: 72,
        functions: 81,
        lines: 78,
      },
    },
  },
});
