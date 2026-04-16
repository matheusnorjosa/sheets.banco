"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";

type Tab = "overview" | "settings" | "keys" | "usage" | "playground" | "computed" | "snapshots" | "sync" | "spreadsheets";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

export default function ApiDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [sheetApi, setSheetApi] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("overview");
  const [deleting, setDeleting] = useState(false);

  const reload = () => {
    api.getApi(id).then((data) => setSheetApi(data.api));
  };

  useEffect(() => {
    api
      .getApi(id)
      .then((data) => setSheetApi(data.api))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="text-[var(--text-tertiary)]">Carregando...</div>;
  if (!sheetApi) return <div className="text-red-400">API não encontrada.</div>;

  const endpoint = `${API_URL}/api/v1/${sheetApi.id}`;
  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Visão Geral" },
    { key: "settings", label: "Configurações" },
    { key: "keys", label: "Chaves de API" },
    { key: "usage", label: "Uso" },
    { key: "playground", label: "Playground" },
    { key: "computed", label: "Calculados" },
    { key: "snapshots", label: "Snapshots" },
    { key: "sync", label: "Sincronização" },
    { key: "spreadsheets", label: "Planilhas" },
  ];

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteApi(id);
      router.push("/apis");
    } catch (err: any) {
      alert("Falha ao excluir: " + (err.message || "Erro desconhecido"));
      setDeleting(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">{sheetApi.name}</h1>
          <p className="text-sm text-[var(--text-muted)] font-mono">{sheetApi.id}</p>
        </div>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="text-red-400 text-sm hover:text-red-300 transition-colors disabled:opacity-50"
        >
          {deleting ? "Excluindo..." : "Excluir API"}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-[var(--card-border)]">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? "border-[var(--accent)] text-[var(--accent-light)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab endpoint={endpoint} sheetApi={sheetApi} />}
      {tab === "settings" && <SettingsTab sheetApi={sheetApi} onUpdate={reload} />}
      {tab === "keys" && <KeysTab sheetApi={sheetApi} onUpdate={reload} />}
      {tab === "usage" && <UsageTab apiId={id} />}
      {tab === "playground" && <PlaygroundTab endpoint={endpoint} />}
      {tab === "computed" && <ComputedFieldsTab apiId={id} />}
      {tab === "snapshots" && <SnapshotsTab apiId={id} />}
      {tab === "sync" && <SyncTab apiId={id} />}
      {tab === "spreadsheets" && <SpreadsheetsTab apiId={id} />}
    </div>
  );
}

function OverviewTab({ endpoint, sheetApi }: { endpoint: string; sheetApi: any }) {
  const [copied, setCopied] = useState(false);

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const [snippetLang, setSnippetLang] = useState("curl");

  const snippets: Record<string, { label: string; code: string }> = {
    curl: { label: "cURL", code: `# Read all rows\ncurl ${endpoint}\n\n# Create a row\ncurl -X POST ${endpoint} \\\n  -H "Content-Type: application/json" \\\n  -d '{"data": {"column": "value"}}'` },
    javascript: { label: "JavaScript", code: `const res = await fetch("${endpoint}");\nconst data = await res.json();\nconsole.log(data);\n\n// Create a row\nawait fetch("${endpoint}?sync=true", {\n  method: "POST",\n  headers: { "Content-Type": "application/json" },\n  body: JSON.stringify({ data: { column: "value" } }),\n});` },
    python: { label: "Python", code: `import requests\n\n# Read all rows\nres = requests.get("${endpoint}")\ndata = res.json()\nprint(data)\n\n# Create a row\nrequests.post("${endpoint}?sync=true",\n  json={"data": {"column": "value"}})` },
    php: { label: "PHP", code: `<?php\n// Read all rows\n$data = json_decode(file_get_contents("${endpoint}"), true);\nprint_r($data);\n\n// Create a row\n$ch = curl_init("${endpoint}?sync=true");\ncurl_setopt($ch, CURLOPT_POST, true);\ncurl_setopt($ch, CURLOPT_HTTPHEADER, ["Content-Type: application/json"]);\ncurl_setopt($ch, CURLOPT_POSTFIELDS, json_encode(["data" => ["column" => "value"]]));\ncurl_setopt($ch, CURLOPT_RETURNTRANSFER, true);\n$res = curl_exec($ch);` },
    ruby: { label: "Ruby", code: `require "net/http"\nrequire "json"\n\n# Read all rows\nuri = URI("${endpoint}")\nres = Net::HTTP.get(uri)\ndata = JSON.parse(res)\nputs data` },
    go: { label: "Go", code: `package main\n\nimport (\n  "fmt"\n  "io"\n  "net/http"\n)\n\nfunc main() {\n  res, _ := http.Get("${endpoint}")\n  body, _ := io.ReadAll(res.Body)\n  fmt.Println(string(body))\n}` },
  };

  return (
    <div className="space-y-6">
      <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-5">
        <h2 className="font-semibold text-[var(--text-primary)] mb-3">Endpoint da API</h2>
        <div className="flex items-center gap-2">
          <code className="flex-1 bg-[var(--input-bg)] px-3 py-2 rounded-lg text-sm font-mono text-[var(--text-secondary)] border border-[var(--input-border)]">
            {endpoint}
          </code>
          <button
            onClick={() => copy(endpoint)}
            className="bg-[var(--card-border)] px-4 py-2 rounded-lg text-sm text-[var(--text-secondary)] hover:bg-[var(--input-border)] transition-colors"
          >
            {copied ? "Copiado!" : "Copiar"}
          </button>
        </div>
      </div>

      <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-5">
        <h2 className="font-semibold text-[var(--text-primary)] mb-3">Início Rápido</h2>
        <div className="flex gap-1 mb-3 flex-wrap">
          {Object.entries(snippets).map(([key, { label }]) => (
            <button key={key} onClick={() => setSnippetLang(key)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${snippetLang === key ? "bg-[var(--accent)] text-white" : "bg-[var(--card-border)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"}`}>
              {label}
            </button>
          ))}
        </div>
        <pre className="bg-[var(--sidebar-bg)] text-green-400 p-3 rounded-lg text-xs overflow-x-auto border border-[var(--card-border)] whitespace-pre">
          {snippets[snippetLang].code}
        </pre>
      </div>

      <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-5">
        <h2 className="font-semibold text-[var(--text-primary)] mb-3">Endpoints Disponíveis</h2>
        <div className="text-sm space-y-2">
          {[
            { method: "GET", color: "text-green-400 bg-green-900/30", path: `/${sheetApi.id}`, desc: "Todas as linhas" },
            { method: "GET", color: "text-green-400 bg-green-900/30", path: `/${sheetApi.id}/search?col=val`, desc: "Buscar" },
            { method: "GET", color: "text-green-400 bg-green-900/30", path: `/${sheetApi.id}/keys`, desc: "Nomes das colunas" },
            { method: "GET", color: "text-green-400 bg-green-900/30", path: `/${sheetApi.id}/count`, desc: "Contagem de linhas" },
            { method: "POST", color: "text-blue-400 bg-blue-900/30", path: `/${sheetApi.id}`, desc: "Criar linhas" },
            { method: "PATCH", color: "text-yellow-400 bg-yellow-900/30", path: `/${sheetApi.id}/:col/:val`, desc: "Atualizar" },
            { method: "DELETE", color: "text-red-400 bg-red-900/30", path: `/${sheetApi.id}/:col/:val`, desc: "Excluir" },
          ].map((ep, i) => (
            <div key={i} className="flex gap-3 items-center">
              <span className={`${ep.color} px-2 py-0.5 rounded text-xs font-mono font-bold w-16 text-center`}>
                {ep.method}
              </span>
              <code className="text-[var(--text-tertiary)] text-xs">{ep.path}</code>
              <span className="text-[var(--text-faint)] text-xs">— {ep.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SettingsTab({ sheetApi, onUpdate }: { sheetApi: any; onUpdate: () => void }) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(sheetApi.name);
  const [allowRead, setAllowRead] = useState(sheetApi.allowRead);
  const [allowCreate, setAllowCreate] = useState(sheetApi.allowCreate);
  const [allowUpdate, setAllowUpdate] = useState(sheetApi.allowUpdate);
  const [allowDelete, setAllowDelete] = useState(sheetApi.allowDelete);
  const [cacheTtl, setCacheTtl] = useState(sheetApi.cacheTtlSeconds);
  const [rateLimitRpm, setRateLimitRpm] = useState(sheetApi.rateLimitRpm);
  const [bearerToken, setBearerToken] = useState(sheetApi.bearerToken || "");
  const [msg, setMsg] = useState("");

  const handleSave = async () => {
    setSaving(true);
    setMsg("");
    try {
      await api.updateApi(sheetApi.id, {
        name, allowRead, allowCreate, allowUpdate, allowDelete,
        cacheTtlSeconds: cacheTtl, rateLimitRpm,
        bearerToken: bearerToken || null,
      });
      setMsg("Configurações salvas!");
      onUpdate();
    } catch (err: any) {
      setMsg(err.message || "Falha ao salvar");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-6 max-w-lg space-y-5">
      {msg && (
        <div className={`text-sm rounded-lg p-3 ${msg.includes("salvas") ? "bg-green-900/30 border border-green-700 text-green-400" : "bg-red-900/30 border border-red-700 text-red-400"}`}>
          {msg}
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">Nome</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="w-full bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)]" />
      </div>

      <div>
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">Permissões</label>
        <div className="space-y-2">
          {[
            { label: "Leitura", value: allowRead, set: setAllowRead },
            { label: "Criação", value: allowCreate, set: setAllowCreate },
            { label: "Atualização", value: allowUpdate, set: setAllowUpdate },
            { label: "Exclusão", value: allowDelete, set: setAllowDelete },
          ].map((perm) => (
            <label key={perm.label} className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
              <input type="checkbox" checked={perm.value} onChange={(e) => perm.set(e.target.checked)} className="rounded bg-[var(--input-bg)] border-[var(--input-border)]" />
              {perm.label}
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">Cache TTL (segundos)</label>
        <input type="number" value={cacheTtl} onChange={(e) => setCacheTtl(Number(e.target.value))} min={0} className="w-full bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)]" />
      </div>

      <div>
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">Limite de Requisições (req/min)</label>
        <input type="number" value={rateLimitRpm} onChange={(e) => setRateLimitRpm(Number(e.target.value))} min={1} className="w-full bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)]" />
      </div>

      <div>
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">Bearer Token (opcional)</label>
        <input type="text" value={bearerToken} onChange={(e) => setBearerToken(e.target.value)} className="w-full bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-secondary)] font-mono focus:outline-none focus:border-[var(--accent)]" placeholder="Deixe vazio para acesso público" />
        <p className="text-xs text-[var(--text-muted)] mt-1.5">Se definido, as requisições devem incluir Authorization: Bearer &lt;token&gt;</p>
      </div>

      <button onClick={handleSave} disabled={saving} className="bg-[var(--accent)] text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors">
        {saving ? "Salvando..." : "Salvar Configurações"}
      </button>
    </div>
  );
}

function KeysTab({ sheetApi, onUpdate }: { sheetApi: any; onUpdate: () => void }) {
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    setCreating(true);
    try {
      await api.createApiKey(sheetApi.id, label || undefined);
      setLabel("");
      onUpdate();
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (keyId: string) => {
    await api.deleteApiKey(sheetApi.id, keyId);
    onUpdate();
  };

  return (
    <div className="space-y-4 max-w-lg">
      <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-5">
        <h2 className="font-semibold text-[var(--text-primary)] mb-3">Criar Chave de API</h2>
        <div className="flex gap-2">
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} className="flex-1 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)]" placeholder="Rótulo (opcional)" />
          <button onClick={handleCreate} disabled={creating} className="bg-[var(--accent)] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors">
            Criar
          </button>
        </div>
      </div>

      {sheetApi.apiKeys && sheetApi.apiKeys.length > 0 ? (
        <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg divide-y divide-[var(--card-border)]">
          {sheetApi.apiKeys.map((k: any) => (
            <div key={k.id} className="p-4 flex items-center justify-between">
              <div>
                <code className="text-sm font-mono bg-[var(--input-bg)] px-2 py-1 rounded text-[var(--text-secondary)]">{k.key}</code>
                {k.label && <span className="ml-2 text-xs text-[var(--text-muted)]">{k.label}</span>}
                <div className="text-xs text-[var(--text-faint)] mt-1">Criado em {new Date(k.createdAt).toLocaleDateString()}</div>
              </div>
              <button onClick={() => handleDelete(k.id)} className="text-red-400 text-xs hover:text-red-300 transition-colors">
                Revogar
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-[var(--text-muted)]">Nenhuma chave de API ainda.</p>
      )}
    </div>
  );
}

const CHART_COLORS = ["#4f46e5", "#22c55e", "#eab308", "#ef4444", "#06b6d4", "#f97316"];

function UsageTab({ apiId }: { apiId: string }) {
  const [usage, setUsage] = useState<any>(null);
  const [chart, setChart] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(7);

  useEffect(() => {
    setLoading(true);
    Promise.all([api.getUsage(apiId, days), api.getUsageChart(apiId, days)])
      .then(([u, c]) => { setUsage(u); setChart(c); })
      .finally(() => setLoading(false));
  }, [apiId, days]);

  if (loading) return <div className="text-[var(--text-tertiary)]">Carregando uso...</div>;
  if (!usage) return <div className="text-[var(--text-muted)]">Sem dados.</div>;

  return (
    <div className="space-y-4">
      {/* Period selector */}
      <div className="flex gap-2">
        {[1, 7, 30].map((d) => (
          <button key={d} onClick={() => setDays(d)}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${days === d ? "bg-[var(--accent)] text-white" : "bg-[var(--card-border)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"}`}>
            {d === 1 ? "24h" : `${d}d`}
          </button>
        ))}
      </div>

      {/* Stats cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-5">
          <p className="text-sm text-[var(--text-muted)] mb-1">Total de Requisições</p>
          <p className="text-3xl font-bold text-[var(--text-primary)]">{usage.total}</p>
        </div>
        <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-5">
          <p className="text-sm text-[var(--text-muted)] mb-1">Requisições no Período</p>
          <p className="text-3xl font-bold text-[var(--text-primary)]">{chart?.total ?? 0}</p>
        </div>
        <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-5">
          <p className="text-sm text-[var(--text-muted)] mb-1">Resposta Média</p>
          <p className="text-3xl font-bold text-[var(--text-primary)]">
            {chart?.timeline?.length ? Math.round(chart.timeline.reduce((s: number, t: any) => s + t.avgMs, 0) / chart.timeline.length) : 0}ms
          </p>
        </div>
      </div>

      {/* Timeline chart */}
      {chart?.timeline?.length > 0 && (
        <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-5">
          <h2 className="font-semibold text-[var(--text-primary)] mb-4">Requisições ao longo do tempo</h2>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chart.timeline}>
              <XAxis dataKey="date" tick={{ fill: "#6b7280", fontSize: 11 }} tickFormatter={(v: string) => v.slice(5)} />
              <YAxis tick={{ fill: "#6b7280", fontSize: 11 }} width={40} />
              <Tooltip contentStyle={{ background: "var(--sidebar-bg)", border: "1px solid var(--card-border)", borderRadius: 8, color: "var(--text-primary)", fontSize: 12 }} />
              <Area type="monotone" dataKey="requests" stroke="#4f46e5" fill="#4f46e5" fillOpacity={0.2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Methods + Status charts */}
      {(chart?.methods?.length > 0 || chart?.statuses?.length > 0) && (
        <div className="grid gap-4 sm:grid-cols-2">
          {chart?.methods?.length > 0 && (
            <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-5">
              <h2 className="font-semibold text-[var(--text-primary)] mb-4">Por Método</h2>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={chart.methods}>
                  <XAxis dataKey="method" tick={{ fill: "#6b7280", fontSize: 11 }} />
                  <YAxis tick={{ fill: "#6b7280", fontSize: 11 }} width={40} />
                  <Tooltip contentStyle={{ background: "var(--sidebar-bg)", border: "1px solid var(--card-border)", borderRadius: 8, color: "var(--text-primary)", fontSize: 12 }} />
                  <Bar dataKey="count" fill="#4f46e5" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          {chart?.statuses?.length > 0 && (
            <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-5">
              <h2 className="font-semibold text-[var(--text-primary)] mb-4">Por Status</h2>
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie data={chart.statuses} dataKey="count" nameKey="status" cx="50%" cy="50%" outerRadius={65} label={(e: any) => `${e.status}: ${e.count}`}>
                    {chart.statuses.map((_: any, i: number) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ background: "var(--sidebar-bg)", border: "1px solid var(--card-border)", borderRadius: 8, color: "var(--text-primary)", fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {/* Recent requests table */}
      {usage.recent.length > 0 && (
        <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg overflow-hidden">
          <h2 className="font-semibold text-[var(--text-primary)] px-4 py-3 border-b border-[var(--card-border)]">Requisições Recentes</h2>
          <table className="w-full text-sm">
            <thead className="bg-[var(--sidebar-bg)] text-[var(--text-muted)] text-xs">
              <tr>
                <th className="text-left px-4 py-2.5">Método</th>
                <th className="text-left px-4 py-2.5">Caminho</th>
                <th className="text-left px-4 py-2.5">Status</th>
                <th className="text-left px-4 py-2.5">Tempo</th>
                <th className="text-left px-4 py-2.5">Data</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--card-border)]">
              {usage.recent.map((log: any, i: number) => (
                <tr key={i} className="hover:bg-[var(--input-bg)]">
                  <td className="px-4 py-2.5 font-mono text-xs text-[var(--text-secondary)]">{log.method}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-[var(--text-tertiary)] truncate max-w-[200px]">{log.path}</td>
                  <td className="px-4 py-2.5">
                    <span className={`text-xs font-medium ${log.statusCode < 400 ? "text-green-400" : "text-red-400"}`}>
                      {log.statusCode}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-[var(--text-muted)]">{log.responseMs}ms</td>
                  <td className="px-4 py-2.5 text-xs text-[var(--text-faint)]">{new Date(log.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PlaygroundTab({ endpoint }: { endpoint: string }) {
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("");
  const [body, setBody] = useState('{\n  "data": {\n    "column": "value"\n  }\n}');
  const [headers, setHeaders] = useState("");
  const [response, setResponse] = useState<{ status: number; body: string; time: number } | null>(null);
  const [loading, setLoading] = useState(false);

  const handleExport = (format: "json" | "csv", pretty?: boolean) => {
    let url = `${endpoint}/export?format=${format}`;
    if (format === "json" && pretty) url += "&pretty=true";
    window.open(url, "_blank");
  };

  const handleSend = async () => {
    setLoading(true);
    setResponse(null);
    const url = `${endpoint}${path}`;
    const start = performance.now();

    try {
      const opts: RequestInit = {
        method,
        headers: { "Content-Type": "application/json" },
      };

      // Parse custom headers
      if (headers.trim()) {
        for (const line of headers.split("\n")) {
          const [k, ...v] = line.split(":");
          if (k && v.length) {
            (opts.headers as Record<string, string>)[k.trim()] = v.join(":").trim();
          }
        }
      }

      if (method !== "GET" && method !== "DELETE" && body.trim()) {
        opts.body = body;
      }

      const res = await fetch(url, opts);
      const text = await res.text();
      const elapsed = Math.round(performance.now() - start);

      let formatted = text;
      try { formatted = JSON.stringify(JSON.parse(text), null, 2); } catch {}

      setResponse({ status: res.status, body: formatted, time: elapsed });
    } catch (err: any) {
      setResponse({ status: 0, body: err.message, time: Math.round(performance.now() - start) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-5">
        <h2 className="font-semibold text-[var(--text-primary)] mb-4">Playground da API</h2>

        {/* Method + Path */}
        <div className="flex gap-2 mb-3">
          <select value={method} onChange={(e) => setMethod(e.target.value)}
            className="bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-secondary)]">
            {["GET", "POST", "PATCH", "DELETE"].map((m) => <option key={m}>{m}</option>)}
          </select>
          <div className="flex-1 flex items-center bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg px-3">
            <span className="text-xs text-[var(--text-muted)] mr-1 truncate">{endpoint}</span>
            <input type="text" value={path} onChange={(e) => setPath(e.target.value)}
              className="flex-1 bg-transparent py-2 text-sm text-[var(--text-secondary)] focus:outline-none" placeholder="/search?name=Alice" />
          </div>
          <button onClick={handleSend} disabled={loading}
            className="bg-[var(--accent)] text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors">
            {loading ? "..." : "Enviar"}
          </button>
        </div>

        {/* Headers */}
        <div className="mb-3">
          <label className="block text-xs text-[var(--text-muted)] mb-1">Headers (um por linha, Chave: Valor)</label>
          <textarea value={headers} onChange={(e) => setHeaders(e.target.value)} rows={2}
            className="w-full bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg px-3 py-2 text-xs text-[var(--text-secondary)] font-mono focus:outline-none focus:border-[var(--accent)]"
            placeholder="Authorization: Bearer token123" />
        </div>

        {/* Body */}
        {method !== "GET" && (
          <div className="mb-3">
            <label className="block text-xs text-[var(--text-muted)] mb-1">Corpo (JSON)</label>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5}
              className="w-full bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg px-3 py-2 text-xs text-[var(--text-secondary)] font-mono focus:outline-none focus:border-[var(--accent)]" />
          </div>
        )}
      </div>

      {/* Response */}
      {response && (
        <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-5">
          <div className="flex items-center gap-3 mb-3">
            <span className={`text-sm font-bold ${response.status >= 200 && response.status < 400 ? "text-green-400" : "text-red-400"}`}>
              {response.status || "Erro"}
            </span>
            <span className="text-xs text-[var(--text-muted)]">{response.time}ms</span>
          </div>
          <pre className="bg-[var(--sidebar-bg)] border border-[var(--card-border)] rounded-lg p-3 text-xs text-[var(--text-secondary)] font-mono overflow-x-auto max-h-[400px] overflow-y-auto">
            {response.body}
          </pre>
        </div>
      )}

      {/* Export */}
      <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-5">
        <h2 className="font-semibold text-[var(--text-primary)] mb-3">Exportar Dados</h2>
        <p className="text-xs text-[var(--text-muted)] mb-3">Baixe todos os dados da planilha em diferentes formatos.</p>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => handleExport("json", true)}
            className="bg-[var(--accent)] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors">
            JSON Formatado
          </button>
          <button onClick={() => handleExport("json")}
            className="bg-[var(--card-border)] text-[var(--text-secondary)] px-4 py-2 rounded-lg text-sm font-medium hover:bg-[var(--input-border)] transition-colors">
            JSON Compacto
          </button>
          <button onClick={() => handleExport("csv")}
            className="bg-[var(--card-border)] text-[var(--text-secondary)] px-4 py-2 rounded-lg text-sm font-medium hover:bg-[var(--input-border)] transition-colors">
            CSV
          </button>
        </div>
      </div>
    </div>
  );
}

function ComputedFieldsTab({ apiId }: { apiId: string }) {
  const [fields, setFields] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [expression, setExpression] = useState("");
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState("");

  const load = () => {
    api.listComputedFields(apiId).then((d) => setFields(d.fields)).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [apiId]);

  const handleCreate = async () => {
    if (!name || !expression) return;
    setCreating(true);
    setMsg("");
    try {
      await api.createComputedField(apiId, name, expression);
      setName("");
      setExpression("");
      load();
      setMsg("Campo criado!");
    } catch (err: any) {
      setMsg(err.message || "Falha");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (fieldId: string) => {
    await api.deleteComputedField(apiId, fieldId);
    load();
  };

  if (loading) return <div className="text-[var(--text-tertiary)]">Carregando...</div>;

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-5">
        <h2 className="font-semibold text-[var(--text-primary)] mb-3">Adicionar Campo Calculado</h2>
        <p className="text-xs text-[var(--text-muted)] mb-3">
          Use {"{{nomeColuna}}"} para referenciar colunas. Suporta templates e matemática: {"{{preco}} * {{qtd}}"}, {"{{primeiro}} {{ultimo}}"}
        </p>
        {msg && (
          <div className={`text-sm rounded-lg p-2 mb-3 ${msg.includes("criado") ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"}`}>{msg}</div>
        )}
        <div className="flex gap-2 mb-2">
          <input type="text" value={name} onChange={(e) => setName(e.target.value)}
            className="w-40 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)]"
            placeholder="Nome do campo" />
          <input type="text" value={expression} onChange={(e) => setExpression(e.target.value)}
            className="flex-1 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-secondary)] font-mono focus:outline-none focus:border-[var(--accent)]"
            placeholder="{{preco}} * {{quantidade}}" />
          <button onClick={handleCreate} disabled={creating}
            className="bg-[var(--accent)] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors">
            Adicionar
          </button>
        </div>
      </div>

      {fields.length > 0 ? (
        <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg divide-y divide-[var(--card-border)]">
          {fields.map((f: any) => (
            <div key={f.id} className="p-4 flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-[var(--text-primary)]">{f.name}</span>
                <code className="ml-3 text-xs text-[var(--text-tertiary)] bg-[var(--input-bg)] px-2 py-1 rounded">{f.expression}</code>
              </div>
              <button onClick={() => handleDelete(f.id)} className="text-red-400 text-xs hover:text-red-300 transition-colors">Remover</button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-[var(--text-muted)]">Nenhum campo calculado ainda. Eles aparecem como colunas virtuais nas respostas da API.</p>
      )}
    </div>
  );
}

function SnapshotsTab({ apiId }: { apiId: string }) {
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [viewData, setViewData] = useState<any>(null);

  const load = () => {
    api.listSnapshots(apiId).then((d) => setSnapshots(d.snapshots)).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [apiId]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      await api.createSnapshot(apiId);
      load();
    } finally {
      setCreating(false);
    }
  };

  const handleView = async (version: number) => {
    const data = await api.getSnapshot(apiId, version);
    setViewData(data.snapshot);
  };

  const handleDelete = async (version: number) => {
    await api.deleteSnapshot(apiId, version);
    setViewData(null);
    load();
  };

  if (loading) return <div className="text-[var(--text-tertiary)]">Carregando...</div>;

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold text-[var(--text-primary)]">Snapshots</h2>
          <button onClick={handleCreate} disabled={creating}
            className="bg-[var(--accent)] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors">
            {creating ? "Criando..." : "Criar Snapshot"}
          </button>
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          Snapshots salvam o estado atual dos seus dados. Acesse via API: <code className="text-[var(--text-tertiary)]">?version=N</code>
        </p>
      </div>

      {snapshots.length > 0 ? (
        <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg divide-y divide-[var(--card-border)]">
          {snapshots.map((s: any) => (
            <div key={s.id} className="p-4 flex items-center justify-between">
              <div>
                <span className="text-sm font-bold text-[var(--text-primary)]">v{s.version}</span>
                <span className="ml-3 text-xs text-[var(--text-tertiary)]">{s.rowCount} linhas, {s.headers.length} colunas</span>
                {s.sheetName && <span className="ml-2 text-xs text-[var(--text-muted)]">({s.sheetName})</span>}
                <div className="text-xs text-[var(--text-faint)] mt-0.5">{new Date(s.createdAt).toLocaleString()}</div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => handleView(s.version)} className="text-[var(--accent-light)] text-xs hover:text-[var(--accent-lighter)] transition-colors">Ver</button>
                <button onClick={() => handleDelete(s.version)} className="text-red-400 text-xs hover:text-red-300 transition-colors">Excluir</button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-[var(--text-muted)]">Nenhum snapshot ainda.</p>
      )}

      {viewData && (
        <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-[var(--text-primary)]">Dados do Snapshot v{viewData.version}</h3>
            <button onClick={() => setViewData(null)} className="text-[var(--text-tertiary)] text-xs hover:text-[var(--text-primary)]">Fechar</button>
          </div>
          <pre className="bg-[var(--sidebar-bg)] border border-[var(--card-border)] rounded-lg p-3 text-xs text-[var(--text-secondary)] font-mono overflow-auto max-h-[400px]">
            {JSON.stringify(viewData.data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function SyncTab({ apiId }: { apiId: string }) {
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncCron, setSyncCron] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api.getSyncSettings(apiId).then((d) => {
      setSyncEnabled(d.sync.syncEnabled);
      setSyncCron(d.sync.syncCron || "");
    }).finally(() => setLoading(false));
  }, [apiId]);

  const handleSave = async () => {
    setSaving(true);
    setMsg("");
    try {
      await api.updateSyncSettings(apiId, {
        syncEnabled,
        syncCron: syncCron || null,
      });
      setMsg("Configurações de sincronização salvas!");
    } catch (err: any) {
      setMsg(err.message || "Falha");
    } finally {
      setSaving(false);
    }
  };

  const handleTrigger = async () => {
    try {
      const result = await api.triggerSync(apiId);
      setMsg(result.message);
    } catch (err: any) {
      setMsg(err.message || "Falha");
    }
  };

  if (loading) return <div className="text-[var(--text-tertiary)]">Carregando...</div>;

  return (
    <div className="space-y-4 max-w-lg">
      <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-5 space-y-4">
        <h2 className="font-semibold text-[var(--text-primary)]">Sincronização Agendada</h2>
        <p className="text-xs text-[var(--text-muted)]">
          Invalide o cache automaticamente em um agendamento para que as respostas da API permaneçam atualizadas.
        </p>

        {msg && (
          <div className={`text-sm rounded-lg p-2 ${msg.includes("salvas") || msg.includes("Cache") ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"}`}>{msg}</div>
        )}

        <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <input type="checkbox" checked={syncEnabled} onChange={(e) => setSyncEnabled(e.target.checked)} className="rounded bg-[var(--input-bg)] border-[var(--input-border)]" />
          Ativar sincronização agendada
        </label>

        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">Expressão Cron</label>
          <input type="text" value={syncCron} onChange={(e) => setSyncCron(e.target.value)}
            className="w-full bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-secondary)] font-mono focus:outline-none focus:border-[var(--accent)]"
            placeholder="*/15 * * * *" />
          <p className="text-xs text-[var(--text-faint)] mt-1">Exemplos: <code>*/15 * * * *</code> (a cada 15 min), <code>0 * * * *</code> (por hora), <code>0 0 * * *</code> (diário)</p>
        </div>

        <div className="flex gap-2">
          <button onClick={handleSave} disabled={saving}
            className="bg-[var(--accent)] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors">
            {saving ? "Salvando..." : "Salvar"}
          </button>
          <button onClick={handleTrigger}
            className="bg-[var(--card-border)] text-[var(--text-secondary)] px-4 py-2 rounded-lg text-sm font-medium hover:bg-[var(--input-border)] transition-colors">
            Sincronizar Agora
          </button>
        </div>
      </div>
    </div>
  );
}

function SpreadsheetsTab({ apiId }: { apiId: string }) {
  const [primary, setPrimary] = useState<any>(null);
  const [additional, setAdditional] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState("");

  const load = () => {
    api.listSpreadsheets(apiId).then((d) => {
      setPrimary(d.primary);
      setAdditional(d.additional);
    }).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [apiId]);

  const handleAdd = async () => {
    if (!url || !label) return;
    setAdding(true);
    setMsg("");
    try {
      await api.addSpreadsheet(apiId, url, label);
      setUrl("");
      setLabel("");
      load();
      setMsg("Planilha vinculada!");
    } catch (err: any) {
      setMsg(err.message || "Falha");
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (sheetId: string) => {
    await api.removeSpreadsheet(apiId, sheetId);
    load();
  };

  if (loading) return <div className="text-[var(--text-tertiary)]">Carregando...</div>;

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-5">
        <h2 className="font-semibold text-[var(--text-primary)] mb-3">Múltiplas Planilhas</h2>
        <p className="text-xs text-[var(--text-muted)] mb-3">
          Vincule Google Sheets adicionais a esta API. Acesse-as via parâmetro <code className="text-[var(--text-tertiary)]">?source=&lt;id&gt;</code>.
        </p>

        {msg && (
          <div className={`text-sm rounded-lg p-2 mb-3 ${msg.includes("vinculada") ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"}`}>{msg}</div>
        )}

        <div className="space-y-2 mb-3">
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)}
            className="w-full bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)]"
            placeholder="Rótulo (ex.: Pedidos 2024)" />
          <div className="flex gap-2">
            <input type="text" value={url} onChange={(e) => setUrl(e.target.value)}
              className="flex-1 bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg px-3 py-2 text-sm text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)]"
              placeholder="URL ou ID do Google Sheets" />
            <button onClick={handleAdd} disabled={adding}
              className="bg-[var(--accent)] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors">
              Vincular
            </button>
          </div>
        </div>
      </div>

      <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg divide-y divide-[var(--card-border)]">
        {/* Primary sheet */}
        {primary && (
          <div className="p-4 flex items-center justify-between">
            <div>
              <span className="text-sm font-medium text-[var(--text-primary)]">{primary.label}</span>
              <span className="ml-2 text-xs bg-[var(--accent-bg)] text-[var(--accent-light)] px-2 py-0.5 rounded">Principal</span>
              <div className="text-xs text-[var(--text-muted)] font-mono mt-0.5">{primary.spreadsheetId}</div>
            </div>
          </div>
        )}

        {/* Additional sheets */}
        {additional.map((s: any) => (
          <div key={s.id} className="p-4 flex items-center justify-between">
            <div>
              <span className="text-sm font-medium text-[var(--text-primary)]">{s.label}</span>
              <div className="text-xs text-[var(--text-muted)] font-mono mt-0.5">
                ID: <code className="text-[var(--text-tertiary)]">{s.id}</code>
              </div>
            </div>
            <button onClick={() => handleRemove(s.id)} className="text-red-400 text-xs hover:text-red-300 transition-colors">Desvincular</button>
          </div>
        ))}
      </div>
    </div>
  );
}
