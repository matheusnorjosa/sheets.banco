"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api-client";

type Tab = "overview" | "settings" | "keys" | "usage";

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

  if (loading) return <div className="text-gray-400">Loading...</div>;
  if (!sheetApi) return <div className="text-red-400">API not found.</div>;

  const endpoint = `${API_URL}/api/v1/${sheetApi.id}`;
  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "settings", label: "Settings" },
    { key: "keys", label: "API Keys" },
    { key: "usage", label: "Usage" },
  ];

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteApi(id);
      router.push("/apis");
    } catch (err: any) {
      alert("Failed to delete: " + (err.message || "Unknown error"));
      setDeleting(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">{sheetApi.name}</h1>
          <p className="text-sm text-gray-500 font-mono">{sheetApi.id}</p>
        </div>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="text-red-400 text-sm hover:text-red-300 transition-colors disabled:opacity-50"
        >
          {deleting ? "Deleting..." : "Delete API"}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-[#2a2a4a]">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? "border-[#4f46e5] text-[#818cf8]"
                : "border-transparent text-gray-500 hover:text-gray-300"
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

  const curlGet = `curl ${endpoint}`;
  const curlPost = `curl -X POST ${endpoint} \\
  -H "Content-Type: application/json" \\
  -d '{"data": {"column": "value"}}'`;
  const jsSnippet = `const res = await fetch("${endpoint}");
const data = await res.json();
console.log(data);`;

  return (
    <div className="space-y-6">
      <div className="bg-[#16213e] border border-[#2a2a4a] rounded-lg p-5">
        <h2 className="font-semibold text-white mb-3">API Endpoint</h2>
        <div className="flex items-center gap-2">
          <code className="flex-1 bg-[#1e1e3a] px-3 py-2 rounded-lg text-sm font-mono text-gray-300 border border-[#3a3a5a]">
            {endpoint}
          </code>
          <button
            onClick={() => copy(endpoint)}
            className="bg-[#2a2a4a] px-4 py-2 rounded-lg text-sm text-gray-300 hover:bg-[#3a3a5a] transition-colors"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>

      <div className="bg-[#16213e] border border-[#2a2a4a] rounded-lg p-5">
        <h2 className="font-semibold text-white mb-3">Quick Start</h2>
        <div className="space-y-4">
          <div>
            <p className="text-xs text-gray-500 mb-1.5 font-medium">GET — Read all rows</p>
            <pre className="bg-[#0f0f23] text-green-400 p-3 rounded-lg text-xs overflow-x-auto border border-[#2a2a4a]">
              {curlGet}
            </pre>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1.5 font-medium">POST — Create a row</p>
            <pre className="bg-[#0f0f23] text-green-400 p-3 rounded-lg text-xs overflow-x-auto border border-[#2a2a4a]">
              {curlPost}
            </pre>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1.5 font-medium">JavaScript</p>
            <pre className="bg-[#0f0f23] text-green-400 p-3 rounded-lg text-xs overflow-x-auto border border-[#2a2a4a]">
              {jsSnippet}
            </pre>
          </div>
        </div>
      </div>

      <div className="bg-[#16213e] border border-[#2a2a4a] rounded-lg p-5">
        <h2 className="font-semibold text-white mb-3">Available Endpoints</h2>
        <div className="text-sm space-y-2">
          {[
            { method: "GET", color: "text-green-400 bg-green-900/30", path: `/${sheetApi.id}`, desc: "All rows" },
            { method: "GET", color: "text-green-400 bg-green-900/30", path: `/${sheetApi.id}/search?col=val`, desc: "Search" },
            { method: "GET", color: "text-green-400 bg-green-900/30", path: `/${sheetApi.id}/keys`, desc: "Column names" },
            { method: "GET", color: "text-green-400 bg-green-900/30", path: `/${sheetApi.id}/count`, desc: "Row count" },
            { method: "POST", color: "text-blue-400 bg-blue-900/30", path: `/${sheetApi.id}`, desc: "Create rows" },
            { method: "PATCH", color: "text-yellow-400 bg-yellow-900/30", path: `/${sheetApi.id}/:col/:val`, desc: "Update" },
            { method: "DELETE", color: "text-red-400 bg-red-900/30", path: `/${sheetApi.id}/:col/:val`, desc: "Delete" },
          ].map((ep, i) => (
            <div key={i} className="flex gap-3 items-center">
              <span className={`${ep.color} px-2 py-0.5 rounded text-xs font-mono font-bold w-16 text-center`}>
                {ep.method}
              </span>
              <code className="text-gray-400 text-xs">{ep.path}</code>
              <span className="text-gray-600 text-xs">— {ep.desc}</span>
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
      setMsg("Settings saved!");
      onUpdate();
    } catch (err: any) {
      setMsg(err.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-[#16213e] border border-[#2a2a4a] rounded-lg p-6 max-w-lg space-y-5">
      {msg && (
        <div className={`text-sm rounded-lg p-3 ${msg.includes("saved") ? "bg-green-900/30 border border-green-700 text-green-400" : "bg-red-900/30 border border-red-700 text-red-400"}`}>
          {msg}
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1.5">Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="w-full bg-[#1e1e3a] border border-[#3a3a5a] rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-[#4f46e5]" />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">Permissions</label>
        <div className="space-y-2">
          {[
            { label: "Read", value: allowRead, set: setAllowRead },
            { label: "Create", value: allowCreate, set: setAllowCreate },
            { label: "Update", value: allowUpdate, set: setAllowUpdate },
            { label: "Delete", value: allowDelete, set: setAllowDelete },
          ].map((perm) => (
            <label key={perm.label} className="flex items-center gap-2 text-sm text-gray-300">
              <input type="checkbox" checked={perm.value} onChange={(e) => perm.set(e.target.checked)} className="rounded bg-[#1e1e3a] border-[#3a3a5a]" />
              {perm.label}
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1.5">Cache TTL (seconds)</label>
        <input type="number" value={cacheTtl} onChange={(e) => setCacheTtl(Number(e.target.value))} min={0} className="w-full bg-[#1e1e3a] border border-[#3a3a5a] rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-[#4f46e5]" />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1.5">Rate Limit (requests/min)</label>
        <input type="number" value={rateLimitRpm} onChange={(e) => setRateLimitRpm(Number(e.target.value))} min={1} className="w-full bg-[#1e1e3a] border border-[#3a3a5a] rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-[#4f46e5]" />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1.5">Bearer Token (optional)</label>
        <input type="text" value={bearerToken} onChange={(e) => setBearerToken(e.target.value)} className="w-full bg-[#1e1e3a] border border-[#3a3a5a] rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:border-[#4f46e5]" placeholder="Leave empty for public access" />
        <p className="text-xs text-gray-500 mt-1.5">If set, requests must include Authorization: Bearer &lt;token&gt;</p>
      </div>

      <button onClick={handleSave} disabled={saving} className="bg-[#4f46e5] text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-[#4338ca] disabled:opacity-50 transition-colors">
        {saving ? "Saving..." : "Save Settings"}
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
      <div className="bg-[#16213e] border border-[#2a2a4a] rounded-lg p-5">
        <h2 className="font-semibold text-white mb-3">Create API Key</h2>
        <div className="flex gap-2">
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} className="flex-1 bg-[#1e1e3a] border border-[#3a3a5a] rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-[#4f46e5]" placeholder="Label (optional)" />
          <button onClick={handleCreate} disabled={creating} className="bg-[#4f46e5] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#4338ca] disabled:opacity-50 transition-colors">
            Create
          </button>
        </div>
      </div>

      {sheetApi.apiKeys && sheetApi.apiKeys.length > 0 ? (
        <div className="bg-[#16213e] border border-[#2a2a4a] rounded-lg divide-y divide-[#2a2a4a]">
          {sheetApi.apiKeys.map((k: any) => (
            <div key={k.id} className="p-4 flex items-center justify-between">
              <div>
                <code className="text-sm font-mono bg-[#1e1e3a] px-2 py-1 rounded text-gray-300">{k.key}</code>
                {k.label && <span className="ml-2 text-xs text-gray-500">{k.label}</span>}
                <div className="text-xs text-gray-600 mt-1">Created {new Date(k.createdAt).toLocaleDateString()}</div>
              </div>
              <button onClick={() => handleDelete(k.id)} className="text-red-400 text-xs hover:text-red-300 transition-colors">
                Revoke
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-500">No API keys yet.</p>
      )}
    </div>
  );
}

function UsageTab({ apiId }: { apiId: string }) {
  const [usage, setUsage] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getUsage(apiId).then(setUsage).finally(() => setLoading(false));
  }, [apiId]);

  if (loading) return <div className="text-gray-400">Loading usage...</div>;
  if (!usage) return <div className="text-gray-500">No data.</div>;

  return (
    <div className="space-y-4">
      <div className="bg-[#16213e] border border-[#2a2a4a] rounded-lg p-5">
        <h2 className="font-semibold text-white mb-2">Total Requests</h2>
        <p className="text-3xl font-bold text-white">{usage.total}</p>
        <p className="text-xs text-gray-500 mt-1">
          Showing last {usage.days} days ({usage.recent.length} recent)
        </p>
      </div>

      {usage.recent.length > 0 && (
        <div className="bg-[#16213e] border border-[#2a2a4a] rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[#0f0f23] text-gray-500 text-xs">
              <tr>
                <th className="text-left px-4 py-2.5">Method</th>
                <th className="text-left px-4 py-2.5">Path</th>
                <th className="text-left px-4 py-2.5">Status</th>
                <th className="text-left px-4 py-2.5">Time</th>
                <th className="text-left px-4 py-2.5">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2a2a4a]">
              {usage.recent.map((log: any, i: number) => (
                <tr key={i} className="hover:bg-[#1e1e3a]">
                  <td className="px-4 py-2.5 font-mono text-xs text-gray-300">{log.method}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-gray-400 truncate max-w-[200px]">{log.path}</td>
                  <td className="px-4 py-2.5">
                    <span className={`text-xs font-medium ${log.statusCode < 400 ? "text-green-400" : "text-red-400"}`}>
                      {log.statusCode}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-500">{log.responseMs}ms</td>
                  <td className="px-4 py-2.5 text-xs text-gray-600">{new Date(log.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
