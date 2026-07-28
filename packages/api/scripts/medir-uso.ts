/**
 * Mede o uso real de `/api/v1/*` a partir do `UsageLog`, para decidir um teto
 * de rate limit sem chutar.
 *
 * Existe porque o rate limit dessa rota **nunca esteve ativo** (faltava `await`
 * no registro do plugin; ver `middleware/rate-limiter.ts`). Ligá-lo é uma
 * mudança de comportamento para os Apps Script de produção — painéis de
 * logística e FRV entram por aqui. O jeito de não derrubá-los é escolher o teto
 * a partir do pico observado, não de um número redondo.
 *
 * O agrupamento espelha o BALDE REAL do limitador: `${sheetApiId}:${ip}`, por
 * minuto (ver `apiRateLimitOptions`). Medir só por API superestimaria o pico,
 * porque requisições de IPs diferentes contam em baldes diferentes.
 *
 * Somente leitura. Não escreve nada e não imprime PII — o `UsageLog` guarda
 * `path` sem querystring justamente para não virar depósito de PII, e o IP sai
 * mascarado no relatório.
 *
 * Uso:
 *   DATABASE_URL=<url do Supabase> npx tsx packages/api/scripts/medir-uso.ts
 *   DATABASE_URL=... npx tsx packages/api/scripts/medir-uso.ts --dias 90
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Quantos dias olhar para trás. Default 30. */
function diasArgumento(): number {
  const i = process.argv.indexOf('--dias');
  if (i === -1) return 30;
  const valor = Number(process.argv[i + 1]);
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new Error('--dias precisa de um número positivo.');
  }
  return valor;
}

/**
 * Mascara o IP mantendo só o suficiente para distinguir origens.
 * O relatório precisa mostrar QUANTAS origens existem, não QUAIS.
 */
function mascarar(ip: string | null): string {
  if (!ip) return '(sem ip)';
  const partes = ip.split('.');
  if (partes.length === 4) return `${partes[0]}.${partes[1]}.x.x`;
  return `${ip.slice(0, 8)}…`; // IPv6
}

interface PicoPorBalde {
  sheetApiId: string;
  ip: string | null;
  minuto: Date;
  reqs: bigint;
}

interface ResumoPorApi {
  sheetApiId: string;
  total: bigint;
  origens: bigint;
  p95ms: number | null;
}

async function main() {
  const dias = diasArgumento();
  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);

  const apis = await prisma.sheetApi.findMany({
    select: { id: true, name: true, rateLimitRpm: true },
  });
  const nomeDe = new Map(apis.map((a) => [a.id, a.name]));
  const tetoDe = new Map(apis.map((a) => [a.id, a.rateLimitRpm]));

  // Pico por balde real do limitador: (api, ip, minuto).
  const picos = await prisma.$queryRaw<PicoPorBalde[]>`
    SELECT "sheetApiId", ip, date_trunc('minute', "createdAt") AS minuto, COUNT(*) AS reqs
    FROM "UsageLog"
    WHERE "createdAt" >= ${desde}
    GROUP BY 1, 2, 3
    ORDER BY reqs DESC
    LIMIT 15
  `;

  const resumo = await prisma.$queryRaw<ResumoPorApi[]>`
    SELECT "sheetApiId",
           COUNT(*) AS total,
           COUNT(DISTINCT ip) AS origens,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY "responseMs") AS p95ms
    FROM "UsageLog"
    WHERE "createdAt" >= ${desde}
    GROUP BY 1
    ORDER BY total DESC
  `;

  console.log(`\nJanela: últimos ${dias} dias (desde ${desde.toISOString().slice(0, 10)})\n`);

  if (resumo.length === 0) {
    console.log('Nenhum registro no UsageLog nessa janela.');
    console.log('Sem dado, NÃO ligue o rate limit — meça primeiro com uma janela maior');
    console.log('(--dias 90) ou confirme que o usage-logger está gravando.\n');
    return;
  }

  console.log('=== Volume por API ===');
  for (const r of resumo) {
    const nome = nomeDe.get(r.sheetApiId) ?? '(desconhecida)';
    const teto = tetoDe.get(r.sheetApiId);
    console.log(
      `${nome.padEnd(28)} total=${String(r.total).padStart(8)}  ` +
        `origens=${String(r.origens).padStart(4)}  p95=${r.p95ms ?? '?'}ms  ` +
        `rateLimitRpm atual=${teto ?? 'null (usa 60)'}`,
    );
  }

  console.log('\n=== Pico por balde do limitador (api + ip + minuto) ===');
  console.log('É ISTO que o teto precisa acomodar.\n');
  for (const p of picos) {
    const nome = nomeDe.get(p.sheetApiId) ?? '(desconhecida)';
    console.log(
      `${String(p.reqs).padStart(5)} req/min  ${nome.padEnd(28)} ` +
        `${mascarar(p.ip).padEnd(18)} ${p.minuto.toISOString().slice(0, 16)}`,
    );
  }

  const maior = picos[0];
  if (maior) {
    const pico = Number(maior.reqs);
    const sugerido = Math.max(60, Math.ceil((pico * 3) / 10) * 10);
    console.log(`\n=== Sugestão ===`);
    console.log(`Maior pico observado: ${pico} req/min num único balde.`);
    console.log(`Teto sugerido: ${sugerido} (3× o pico, arredondado, piso de 60).`);
    console.log(
      `\nA folga de 3× existe porque a janela não viu tudo: fechamento de mês,\n` +
        `reprocessamento e execução manual saem do padrão. Comece folgado — o\n` +
        `limite serve para conter laço descontrolado, não para espremer uso normal.`,
    );
    console.log(
      `\nAplicar por API (não global):\n` +
        `  UPDATE "SheetApi" SET "rateLimitRpm" = ${sugerido} WHERE id = '<id>';`,
    );
  }
  console.log('');
}

main()
  .catch((erro) => {
    console.error('Falhou:', erro instanceof Error ? erro.message : erro);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
