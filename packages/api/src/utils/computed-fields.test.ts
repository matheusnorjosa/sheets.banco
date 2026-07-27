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
 * O segundo bloco protege a correção que veio junto: a decisão "isto é
 * matemática?" olha a EXPRESSÃO com os placeholders neutralizados, não o texto
 * já substituído. Antes ela olhava o resultado, e o **valor da célula**
 * decidia — um CPF virava conta (`012.345.678-90` saía `-77.66`), um código
 * perdia o zero à esquerda. Não era ataque: era dado normal da planilha sendo
 * corrompido em silêncio. Cada teste de lá traz, no comentário, o que saía
 * antes.
 *
 * O que continua travado como comportamento atual está marcado com ACHADO —
 * parêntese desbalanceado aceito, campo que não enxerga outro campo, e campo
 * que sobrescreve coluna real da planilha.
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

describe('o valor da célula NÃO decide se há cálculo — quem decide é a expressão', () => {
  // Este bloco existe por causa de um defeito que já foi real: o
  // `evaluateExpression` chamava o avaliador sobre a string JÁ SUBSTITUÍDA, e
  // a pergunta "isto é matemática?" era feita ao resultado. O conteúdo da
  // planilha decidia. Um campo que só repassava uma coluna corrompia o valor
  // sempre que ele parecesse uma conta.
  //
  // Hoje a decisão olha a expressão com os placeholders neutralizados
  // (`isArithmeticExpression`). Cada teste abaixo tem, no comentário, o que
  // saía antes.

  it('CPF passa intacto — antes virava "-77.66"', () => {
    // O pior caso conhecido: `012.345.678-90` só tem dígito, ponto e hífen,
    // todos aceitos pelo avaliador, então era lido como aritmética.
    expect(evaluateExpression('{{cpf}}', linha({ cpf: '012.345.678-90' }))).toBe('012.345.678-90');
  });

  it('zero à esquerda sobrevive — antes "0601001" virava "601001"', () => {
    // A mesma armadilha que mordeu a migração do Protheus, do lado da resposta
    // da API: código de produto perdendo o zero em silêncio.
    expect(evaluateExpression('{{codigo}}', linha({ codigo: '0601001' }))).toBe('0601001');
    expect(evaluateExpression('{{codigo}}', linha({ codigo: '007' }))).toBe('007');
  });

  it('célula contendo uma conta não é calculada — antes "2*3" virava "6"', () => {
    // A pessoa digitou o texto "2*3" numa célula; isso é dado, não fórmula.
    expect(evaluateExpression('{{a}}', linha({ a: '2*3' }))).toBe('2*3');
  });

  it('espaço em volta do valor é preservado — antes "  7  " virava "7"', () => {
    expect(evaluateExpression('{{a}}', linha({ a: '  7  ' }))).toBe('  7  ');
  });

  it('precisão é preservada — antes "1.005" virava "1.00"', () => {
    // Preço com três casas, coordenada geográfica, percentual: tudo truncava.
    expect(evaluateExpression('{{a}}', linha({ a: '1.005' }))).toBe('1.005');
  });

  it('telefone e valor monetário formatado passam intactos', () => {
    expect(evaluateExpression('{{tel}}', linha({ tel: '85-99999-1234' }))).toBe('85-99999-1234');
    expect(evaluateExpression('{{v}}', linha({ v: '1.234' }))).toBe('1.234');
  });

  it('texto, vazio e negativo continuam intactos', () => {
    expect(evaluateExpression('{{a}}', linha({ a: 'Ana' }))).toBe('Ana');
    expect(evaluateExpression('{{a}}', linha({ a: '' }))).toBe('');
    expect(evaluateExpression('{{a}}', linha({ a: '-5' }))).toBe('-5');
  });

  it('mas com operador na EXPRESSÃO o cálculo acontece normalmente', () => {
    // O contraponto que impede a correção de virar "nunca calcula nada": a
    // mesma célula que passa intacta em `{{a}}` é somada em `{{a}} + {{b}}`.
    expect(evaluateExpression('{{a}}', linha({ a: '10' }))).toBe('10');
    expect(evaluateExpression('{{a}} + {{b}}', linha({ a: '10', b: '5' }))).toBe('15');
  });

  it('operador dentro de texto não dispara cálculo', () => {
    // `Total: {{a}} - {{b}}` tem hífen, mas também tem letras, então o que
    // sobra depois de neutralizar os placeholders não é aritmética pura.
    expect(evaluateExpression('Total: {{a}} - {{b}}', linha({ a: '10', b: '5' })))
      .toBe('Total: 10 - 5');
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
