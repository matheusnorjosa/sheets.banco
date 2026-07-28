#!/usr/bin/env node

/**
 * CLI do sheets.banco.
 *
 * ## Sobre os alertas `js/file-access-to-http` do CodeQL
 *
 * O CodeQL aponta dois fluxos aqui, e os dois são **o propósito da
 * ferramenta**, não vazamento:
 *
 * - **"File data in outbound network request"** — o CLI lê `apiUrl` e `token`
 *   de `~/.sheets-banco/config.json` e os envia no `fetch`. É como qualquer
 *   CLI autenticado funciona (`gh`, `aws`, `docker` fazem o mesmo); a
 *   alternativa seria pedir o token a cada comando.
 * - **"Network data written to file"** — `sheets-banco export --output x.csv`
 *   grava em disco o que a API respondeu. É o comando fazendo o que o nome diz.
 *
 * Em ambos os casos o "untrusted data" é o conteúdo da planilha do próprio
 * usuário, obtido de uma API que ele configurou, escrito num caminho que ele
 * escolheu. Não há elevação: quem roda o CLI já tem o token e já pode escrever
 * onde quiser.
 *
 * Os fluxos sempre existiram; passaram a ser rastreáveis quando o tratamento
 * de resposta foi extraído para `lerCorpo()`. Os alertas correspondentes estão
 * dispensados no painel apontando para este comentário.
 *
 * O que de fato protege o token é a permissão do arquivo — `0600` em diretório
 * `0700`, ver `saveConfig` abaixo.
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.sheets-banco');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

interface Config {
  apiUrl: string;
  token?: string;
}

function loadConfig(): Config {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {}
  return { apiUrl: 'http://localhost:3000' };
}

function saveConfig(config: Config): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    // `0o700`: só o dono entra no diretório. Sem isso, em máquina
    // multiusuário ou container compartilhado qualquer um lista o conteúdo.
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  // `0o600`: o arquivo guarda o Bearer token. Sem `mode`, ele nascia com a
  // permissão padrão do sistema (tipicamente 0644) e ficava legível por
  // qualquer usuário local — mesma classe de descuido que um `~/.ssh` aberto.
  // No Windows o `mode` é ignorado pelo Node; a proteção vale onde ela importa
  // (Linux/macOS, e o container de CI).
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * Lê o corpo da resposta tolerando o que não é JSON.
 *
 * `await res.json()` direto estourava `SyntaxError: Unexpected token '<'`
 * sempre que vinha HTML de proxy/CDN (comum num 502 do Render) ou corpo vazio.
 * Combinado com o `program.parse()` sem `await`, isso virava
 * `unhandledRejection` — stack trace cru, sem mensagem útil.
 */
async function lerCorpo(res: Response): Promise<Record<string, unknown> | null> {
  const texto = await res.text();
  if (texto.trim().length === 0) return null;
  try {
    return JSON.parse(texto) as Record<string, unknown>;
  } catch {
    const trecho = texto.trim().replace(/\s+/g, ' ').slice(0, 80);
    return { message: `resposta HTTP ${res.status} não é JSON: ${trecho}` };
  }
}

/** Mensagem de erro da resposta, com fallback — `Error: undefined` não ajuda. */
function mensagemDeErro(corpo: Record<string, unknown> | null, status: number): string {
  const msg = corpo?.message;
  const base = typeof msg === 'string' && msg.length > 0 ? msg : `Request failed (HTTP ${status})`;
  const id = corpo?.request_id;
  // O request_id é o que o suporte precisa para achar a requisição no log.
  return typeof id === 'string' ? `${base} (request_id: ${id})` : base;
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<any> {
  const config = loadConfig();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (config.token) {
    headers['Authorization'] = `Bearer ${config.token}`;
  }

  const res = await fetch(`${config.apiUrl}${path}`, { ...options, headers });
  const data = await lerCorpo(res);

  if (!res.ok) {
    console.error(`Error: ${mensagemDeErro(data, res.status)}`);
    process.exit(1);
  }

  return data;
}

const program = new Command();

program
  .name('sheets-banco')
  .description('CLI for sheets.banco — turn Google Sheets into REST APIs')
  .version('0.1.0');

// init
program
  .command('init')
  .description('Configure the CLI with your API URL')
  .argument('[url]', 'API base URL', 'http://localhost:3000')
  .action((url: string) => {
    const config = loadConfig();
    config.apiUrl = url;
    saveConfig(config);
    console.log(`Configured API URL: ${url}`);
    console.log(`Config saved to: ${CONFIG_FILE}`);
  });

// login
program
  .command('login')
  .description('Login to your sheets.banco account')
  .requiredOption('-e, --email <email>', 'Email address')
  .requiredOption('-p, --password <password>', 'Password')
  .action(async (opts: { email: string; password: string }) => {
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: opts.email, password: opts.password }),
    });

    if (data.requires2FA) {
      console.error('2FA is enabled. CLI login with 2FA is not yet supported.');
      process.exit(1);
    }

    const config = loadConfig();
    config.token = data.token;
    saveConfig(config);
    console.log(`Logged in as: ${data.user.email}`);
  });

// logout
program
  .command('logout')
  .description('Clear saved credentials')
  .action(() => {
    const config = loadConfig();
    delete config.token;
    saveConfig(config);
    console.log('Logged out.');
  });

// apis list
const apis = program.command('apis').description('Manage your APIs');

apis
  .command('list')
  .description('List all your APIs')
  .action(async () => {
    const data = await apiFetch('/dashboard/apis');
    if (data.apis.length === 0) {
      console.log('No APIs found. Create one with: sheets-banco apis create <url> --name "Name"');
      return;
    }
    console.log('\nYour APIs:\n');
    for (const api of data.apis) {
      console.log(`  ${api.name}`);
      console.log(`    ID:   ${api.id}`);
      if (api.slug) console.log(`    Slug: ${api.slug}`);
      console.log(`    Requests: ${api._count?.usageLogs ?? 0}  Keys: ${api._count?.apiKeys ?? 0}`);
      console.log('');
    }
  });

apis
  .command('create')
  .description('Create a new API from a Google Sheet URL')
  .argument('<spreadsheet-url>', 'Google Sheet URL')
  .requiredOption('-n, --name <name>', 'API name')
  .option('-s, --slug <slug>', 'Custom slug')
  .action(async (url: string, opts: { name: string; slug?: string }) => {
    const body: Record<string, string> = { name: opts.name, spreadsheetUrl: url };
    if (opts.slug) body.slug = opts.slug;

    const data = await apiFetch('/dashboard/apis', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    console.log(`API created: ${data.api.name}`);
    console.log(`  ID:       ${data.api.id}`);
    console.log(`  Endpoint: ${loadConfig().apiUrl}/api/v1/${data.api.slug || data.api.id}`);
  });

// export
program
  .command('export')
  .description('Export data from an API')
  .argument('<api-id>', 'API ID or slug')
  .option('-f, --format <format>', 'Output format (json|csv)', 'json')
  .option('-o, --output <file>', 'Output file path')
  .action(async (apiId: string, opts: { format: string; output?: string }) => {
    const config = loadConfig();
    const headers: Record<string, string> = {};
    if (config.token) headers['Authorization'] = `Bearer ${config.token}`;

    const res = await fetch(
      `${config.apiUrl}/api/v1/${apiId}/export?format=${opts.format}`,
      { headers },
    );

    if (!res.ok) {
      console.error(`Error: ${mensagemDeErro(await lerCorpo(res), res.status)}`);
      process.exit(1);
    }

    const content = await res.text();

    if (opts.output) {
      fs.writeFileSync(opts.output, content);
      console.log(`Exported to: ${opts.output}`);
    } else {
      console.log(content);
    }
  });

// types
program
  .command('types')
  .description('Generate TypeScript types from API schema')
  .argument('<api-id>', 'API ID or slug')
  .option('-o, --output <file>', 'Output file path', 'types.ts')
  .action(async (apiId: string, opts: { output: string }) => {
    const config = loadConfig();
    const headers: Record<string, string> = {};
    if (config.token) headers['Authorization'] = `Bearer ${config.token}`;

    const res = await fetch(`${config.apiUrl}/api/v1/${apiId}/schema`, { headers });
    if (!res.ok) {
      console.error(`Error: ${mensagemDeErro(await lerCorpo(res), res.status)}`);
      process.exit(1);
    }

    const data = await res.json() as { columns: { name: string; type: string }[] };

    const tsMap: Record<string, string> = { string: 'string', number: 'number', boolean: 'boolean' };
    const fields = data.columns
      .map((col) => `  ${col.name}: ${tsMap[col.type] || 'string'};`)
      .join('\n');

    const interfaceName = apiId
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_(.)/g, (_, c) => c.toUpperCase())
      .replace(/^./, (c) => c.toUpperCase());

    const content = `// Auto-generated by sheets-banco CLI\n// API: ${apiId}\n\nexport interface ${interfaceName}Row {\n${fields}\n}\n`;

    fs.writeFileSync(opts.output, content);
    console.log(`Types generated: ${opts.output}`);
    console.log(`Interface: ${interfaceName}Row`);
  });

// `parseAsync`, não `parse`: os action handlers são async e o commander só
// aguarda a cadeia na versão async. Com `parse()` a promessa era DESCARTADA —
// qualquer rejeição dentro de um comando (API fora do ar, DNS, corpo de erro
// inesperado) virava `unhandledRejection`: stack cru e código de saída errado.
program.parseAsync().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  // `exitCode`, não `exit()`: o `process.exit()` encerra na hora e pode cortar
  // o `console.error` acima antes de ele chegar ao terminal quando a saída é
  // um pipe. Marcar o código deixa o Node sair naturalmente, depois de drenar.
  process.exitCode = 1;
});
