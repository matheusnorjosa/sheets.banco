/**
 * Testes de caracterização de `utils/computed-fields.ts` — o avaliador de
 * campos calculados.
 *
 * Por que este arquivo merece atenção especial: ele é a **única** parte da API
 * que executa expressão fornecida pelo usuário, e roda **para cada linha de
 * cada resposta** que tenha campo calculado configurado. Estava em 5,88% de
 * cobertura — os 5,88% eram o `if (fields.length === 0) return rows`, tocado de
 * raspão pelos testes de rota.
 *
 * A boa notícia primeiro: **não há execução de código.** Não existe `eval` nem
 * `Function`, e o `safeMathEval` aceita apenas dígito, os quatro operadores
 * aritméticos, parêntese e ponto — qualquer letra derruba a expressão para o
 * caminho de texto. Isso está travado abaixo.
 *
 * A má notícia é o que estes testes documentam: a decisão "isto é matemática?"
 * acontece DEPOIS da substituição, sobre a string já montada. Ou seja, o
 * **valor da célula** participa da decisão. Um CPF vira conta, um código com
 * zero à esquerda perde o zero. Nada disso é ataque — é dado normal da planilha
 * sendo corrompido em silêncio.
 *
 * Os casos assim estão marcados com ACHADO. Eles travam o comportamento de
 * HOJE; não são endosso dele. Se a decisão de matemática passar a olhar a
 * expressão em vez do resultado substituído, estes testes falham de propósito e
 * devem ser reescritos junto com a correção.
 */
import { describe, it, expect } from 'vitest';
import { evaluateExpression, applyComputedFields } from './computed-fields.js';
import type { SheetRow } from '../services/google-sheets.service.js';

/** Atalho: o tipo real é `SheetRow`, mas nos testes basta um mapa de strings. */
const linha = (r: Record<string, string>) => r as SheetRow;

describe('substituição de {{coluna}}', () => {
  it('junta duas colunas de texto', () => {
    expect(evaluateExpression('{{a}} {{b}}', linha({ a: 'Ana', b: 'Silva' }))).toBe('Ana Silva');
  });

  it('mistura texto fixo e coluna', () => {
    expect(evaluateExpression('Total: {{a}}', linha({ a: '10' }))).toBe('Total: 10');
  });

  it('coluna inexistente vira string vazia, não quebra nem deixa o {{...}}', () => {
    expect(evaluateExpression('{{faltante}}', linha({}))).toBe('');
    expect(evaluateExpression('[{{faltante}}]', linha({}))).toBe('[]');
  });

  it('o placeholder só aceita \\w — {{a-b}} fica literal na saída', () => {
    // `TEMPLATE_RE` é /\{\{(\w+)\}\}/g. Nome de coluna com hífen, espaço ou
    // acento não é substituído e sai como está. Como o dashboard só aceita
    // nome `^\w+$` ao criar o campo, isso só aparece se alguém escrever o
    // placeholder à mão apontando para uma coluna da planilha com hífen.
    expect(evaluateExpression('{{a-b}}', linha({ a: '1' }))).toBe('{{a-b}}');
  });
});

describe('expressão aritmética — o caso de uso que a funcionalidade existe para atender', () => {
  it('multiplica duas colunas', () => {
    expect(evaluateExpression('{{preco}} * {{qtd}}', linha({ preco: '10', qtd: '3' }))).toBe('30');
  });

  it('respeita precedência: * antes de +', () => {
    expect(evaluateExpression('{{a}} + {{b}} * {{c}}', linha({ a: '2', b: '3', c: '4' }))).toBe('14');
  });

  it('respeita parênteses', () => {
    expect(evaluateExpression('({{a}} + {{b}}) * {{c}}', linha({ a: '2', b: '3', c: '4' }))).toBe('20');
  });

  it('subtração pode dar negativo', () => {
    expect(evaluateExpression('{{a}} - {{b}}', linha({ a: '5', b: '8' }))).toBe('-3');
  });

  it('resultado inteiro sai sem casas decimais; fracionário sai com duas', () => {
    expect(evaluateExpression('{{a}} / {{b}}', linha({ a: '6', b: '3' }))).toBe('2');
    expect(evaluateExpression('{{a}} / {{b}}', linha({ a: '1', b: '3' }))).toBe('0.33');
  });

  it('divisão por zero devolve a expressão como TEXTO, não "Infinity"', () => {
    // `1/0` é Infinity, `isFinite` é falso, então cai no caminho de texto. E
    // repare que o texto devolvido é o SUBSTITUÍDO com o espaçamento original
    // ("1 / 0"), não o sanitizado — a sanitização só existe dentro do
    // `safeMathEval`. Estranho, mas melhor que devolver "Infinity", e é o que
    // os consumidores veem hoje.
    expect(evaluateExpression('{{a}} / {{b}}', linha({ a: '1', b: '0' }))).toBe('1 / 0');
    expect(evaluateExpression('{{a}}/{{b}}', linha({ a: '1', b: '0' }))).toBe('1/0');
  });
});

describe('não há execução de código — só as quatro operações', () => {
  // Estes testes existem para que uma "melhoria" futura que troque o parser
  // recursivo por `Function()` ou `eval()` quebre aqui em vez de virar RCE.
  it.each([
    ['chamada de função', '{{a}}.toString()', { a: '1' }],
    ['acesso a global', 'process.exit(1)', {}],
    ['template de shell', '$({{a}})', { a: '1' }],
    ['operador de potência não existe', '{{a}} ** {{b}}', { a: '2', b: '3' }],
    ['operador de módulo não existe', '{{a}} % {{b}}', { a: '7', b: '2' }],
  ])('%s não é avaliado — sai como texto substituído', (_rotulo, expressao, dados) => {
    const saida = evaluateExpression(expressao, linha(dados));
    // Qualquer caractere fora de [\d+\-*/().] derruba o `safeMathEval` para
    // null e a saída é a string com os {{...}} trocados, nada mais.
    expect(saida).toBe(expressao.replace(/\{\{(\w+)\}\}/g, (_, c) => (dados as Record<string, string>)[c] ?? ''));
  });

  it('o valor da célula também não escapa do allowlist', () => {
    expect(evaluateExpression('{{a}}', linha({ a: 'process.exit(1)' }))).toBe('process.exit(1)');
  });
});

describe('ACHADO: o valor da célula é avaliado como aritmética', () => {
  // A raiz de tudo nesta seção: `evaluateExpression` chama `safeMathEval` sobre
  // a string JÁ SUBSTITUÍDA. A pergunta "isto é matemática?" é feita ao
  // resultado, não à expressão — então o conteúdo da planilha decide.
  //
  // Consequência: um campo calculado que só REPASSA uma coluna (`{{col}}`,
  // sem nenhum operador) corrompe o valor sempre que ele parecer uma conta.

  it('CPF vira conta: "012.345.678-90" sai como "-77.66"', () => {
    // O pior caso conhecido. `012.345.678-90` só tem dígitos, ponto e hífen —
    // todos no allowlist — então o parser lê como aritmética e devolve um
    // número. Qualquer campo calculado sobre a coluna de CPF destrói o dado.
    expect(evaluateExpression('{{cpf}}', linha({ cpf: '012.345.678-90' }))).toBe('-77.66');
  });

  it('zero à esquerda some: código "0601001" sai como "601001"', () => {
    // Este projeto já foi mordido por zero à esquerda na migração do Protheus:
    // a coluna de código de produto precisa ser Texto puro na planilha senão o
    // zero some. Aqui ele some de novo, do outro lado, na resposta da API.
    expect(evaluateExpression('{{codigo}}', linha({ codigo: '0601001' }))).toBe('601001');
    expect(evaluateExpression('{{codigo}}', linha({ codigo: '007' }))).toBe('7');
  });

  it('célula contendo uma conta é calculada', () => {
    // A pessoa digitou o texto "2*3" na planilha; a API responde "6".
    expect(evaluateExpression('{{a}}', linha({ a: '2*3' }))).toBe('6');
  });

  it('espaço em volta do número é descartado', () => {
    // `sanitized = expr.replace(/\s+/g, '')` remove TODO espaço antes de
    // decidir. "  7  " vira "7" e é tratado como número.
    expect(evaluateExpression('{{a}}', linha({ a: '  7  ' }))).toBe('7');
  });

  it('precisão se perde: "1.005" sai como "1.00"', () => {
    // `toFixed(2)` em valor fracionário. Preço com três casas, coordenada
    // geográfica, percentual — tudo trunca.
    expect(evaluateExpression('{{a}}', linha({ a: '1.005' }))).toBe('1.00');
  });

  it('mas notação científica escapa, porque "e" não está no allowlist', () => {
    // Assimetria que vale conhecer: "1e3" tem letra, então NÃO é avaliado e
    // passa intacto — enquanto "1000" seria normalizado. O critério não é
    // "parece número", é "casa o allowlist".
    expect(evaluateExpression('{{x}}', linha({ x: '1e3' }))).toBe('1e3');
  });

  it('texto puro e valor vazio passam intactos', () => {
    // O contraponto necessário: se TUDO fosse corrompido, os testes acima não
    // distinguiriam avaliação de destruição.
    expect(evaluateExpression('{{a}}', linha({ a: 'Ana' }))).toBe('Ana');
    expect(evaluateExpression('{{a}}', linha({ a: '' }))).toBe('');
    expect(evaluateExpression('{{a}}', linha({ a: '-5' }))).toBe('-5');
  });
});

describe('ACHADO: o parser aceita parêntese desbalanceado', () => {
  it('"(1+2" (sem fechar) devolve 3 em vez de recusar', () => {
    // `parseFactor` faz `state.pos++` para "pular o )" sem conferir que existe
    // um `)` ali. Sobra ou falta de parêntese não vira erro.
    expect(evaluateExpression('(1+2', linha({}))).toBe('3');
  });

  it('"()" vazio não estoura — cai no caminho de texto', () => {
    // Aqui o `parseFloat('')` dá NaN e o parser lança; o `catch` do
    // `safeMathEval` devolve null e a saída é a string original.
    expect(evaluateExpression('()', linha({}))).toBe('()');
  });

  it('aninhamento profundo não derruba o processo', () => {
    // Expressão longa de parênteses aninhados pode estourar a pilha do parser
    // recursivo. O `catch` do `safeMathEval` captura RangeError também, então
    // o resultado é o texto — nunca um 500.
    const fundo = '('.repeat(5000) + '1' + ')'.repeat(5000);
    expect(() => evaluateExpression(fundo, linha({}))).not.toThrow();
  });
});

describe('applyComputedFields', () => {
  it('sem campos, devolve o MESMO array (não copia)', () => {
    const linhas = [linha({ a: '1' })];
    expect(applyComputedFields(linhas, [])).toBe(linhas);
  });

  it('acrescenta o campo em cada linha sem mutar a original', () => {
    const linhas = [linha({ preco: '10' }), linha({ preco: '20' })];
    const saida = applyComputedFields(linhas, [{ name: 'dobro', expression: '{{preco}} * 2' }]);

    expect(saida).toEqual([
      { preco: '10', dobro: '20' },
      { preco: '20', dobro: '40' },
    ]);
    // A linha de origem continua intacta — importante porque ela vem do cache
    // do Google Sheets e é compartilhada entre requisições.
    expect(linhas).toEqual([{ preco: '10' }, { preco: '20' }]);
  });

  it('ACHADO: campo calculado NÃO enxerga outro campo calculado', () => {
    // `evaluateExpression(field.expression, row)` recebe a linha ORIGINAL, não
    // a estendida. Então `{{dobro}}` dentro de outro campo resolve para vazio,
    // em silêncio — sem erro, sem aviso, sem o `{{dobro}}` literal na saída.
    const saida = applyComputedFields(
      [linha({ preco: '10' })],
      [
        { name: 'dobro', expression: '{{preco}} * 2' },
        { name: 'usaDobro', expression: 'valor: {{dobro}}' },
      ],
    );

    expect(saida[0]).toEqual({ preco: '10', dobro: '20', usaDobro: 'valor: ' });
  });

  it('ACHADO: campo com nome de coluna existente SOBRESCREVE a coluna real', () => {
    // O dashboard valida o nome como `^\w+$` mas não confere colisão com as
    // colunas da planilha. Um campo chamado "nome" apaga o nome de verdade da
    // resposta — o consumidor não tem como perceber que o dado sumiu.
    const saida = applyComputedFields(
      [linha({ nome: 'Ana', preco: '10' })],
      [{ name: 'nome', expression: 'sobrescreve' }],
    );

    expect(saida[0]).toEqual({ nome: 'sobrescreve', preco: '10' });
  });

  it('lista de linhas vazia com campos configurados devolve lista vazia', () => {
    expect(applyComputedFields([], [{ name: 'x', expression: '1' }])).toEqual([]);
  });
});
