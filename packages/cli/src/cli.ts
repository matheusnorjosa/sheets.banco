#!/usr/bin/env node

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
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
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
  const data = await res.json() as Record<string, any>;

  if (!res.ok) {
    console.error(`Error: ${data.message || 'Request failed'}`);
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
      const err = await res.json() as Record<string, any>;
      console.error(`Error: ${err.message}`);
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
      const err = await res.json() as Record<string, any>;
      console.error(`Error: ${err.message}`);
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

program.parse();
