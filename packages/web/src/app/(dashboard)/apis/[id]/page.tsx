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

  const reload = () => {
    api.getApi(id).then((data) => setSheetApi(data.api));
  };

  useEffect(() => {
    api
      .getApi(id)
      .then((data) => setSheetApi(data.api))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="text-gray-500">Loading...</div>;
  if (!sheetApi) return <div className="text-red-500">API not found.</div>;

  const endpoint = `${API_URL}/api/v1/${sheetApi.id}`;
  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "settings", label: "Settings" },
    { key: "keys", label: "API Keys" },
    { key: "usage", label: "Usage" },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">{sheetApi.name}</h1>
          <p className="text-sm text-gray-400 font-mono">{sheetApi.id}</p>
        </div>
        <button
          onClick={async () => {
            if (confirm("Delete this API? This cannot be undone.")) {
              await api.deleteApi(id);
              router.push("/apis");
            }
          }}
          className="text-red-600 text-sm hover:underline"
        >
          Delete API
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === t.key
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <OverviewTab endpoint={endpoint} sheetApi={sheetApi} />
      )}
      {tab === "settings" && (
        <SettingsTab sheetApi={sheetApi} onUpdate={reload} />
      )}
      {tab === "keys" && <KeysTab sheetApi={sheetApi} onUpdate={reload} />}
      {tab === "usage" && <UsageTab apiId={id} />}
    </div>
  );
}

function OverviewTab({
  endpoint,
  sheetApi,
}: {
  endpoint: string;
  sheetApi: any;
}) {
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
      <div className="bg-white rounded-lg shadow p-5">
        <h2 className="font-semibold mb-3">API Endpoint</h2>
        <div className="flex items-center gap-2">
          <code className="flex-1 bg-gray-100 px-3 py-2 rounded text-sm font-mono">
            {endpoint}
          </code>
          <button
            onClick={() => copy(endpoint)}
            className="bg-gray-200 px-3 py-2 rounded text-sm hover:bg-gray-300"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow p-5">
        <h2 className="font-semibold mb-3">Quick Start</h2>
        <div className="space-y-4">
          <div>
            <p className="text-xs text-gray-500 mb-1 font-medium">
              GET — Read all rows
            </p>
            <pre className="bg-gray-900 text-green-400 p-3 rounded text-xs overflow-x-auto">
              {curlGet}
            </pre>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1 font-medium">
              POST — Create a row
            </p>
            <pre className="bg-gray-900 text-green-400 p-3 rounded text-xs overflow-x-auto">
              {curlPost}
            </pre>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1 font-medium">
              JavaScript
            </p>
            <pre className="bg-gray-900 text-green-400 p-3 rounded text-xs overflow-x-auto">
              {jsSnippet}
            </pre>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow p-5">
        <h2 className="font-semibold mb-3">Available Endpoints</h2>
        <div className="text-sm space-y-2">
          <div className="flex gap-3">
            <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded text-xs font-mono font-bold w-16 text-center">
              GET
            </span>
            <code className="text-gray-600">/{sheetApi.id}</code>
            <span className="text-gray-400">— All rows</span>
          </div>
          <div className="flex gap-3">
            <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded text-xs font-mono font-bold w-16 text-center">
              GET
            </span>
            <code className="text-gray-600">/{sheetApi.id}/search?col=val</code>
            <span className="text-gray-400">— Search</span>
          </div>
          <div className="flex gap-3">
            <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded text-xs font-mono font-bold w-16 text-center">
              GET
            </span>
            <code className="text-gray-600">/{sheetApi.id}/keys</code>
            <span className="text-gray-400">— Column names</span>
          </div>
          <div className="flex gap-3">
            <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded text-xs font-mono font-bold w-16 text-center">
              GET
            </span>
            <code className="text-gray-600">/{sheetApi.id}/count</code>
            <span className="text-gray-400">— Row count</span>
          </div>
          <div className="flex gap-3">
            <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-xs font-mono font-bold w-16 text-center">
              POST
            </span>
            <code className="text-gray-600">/{sheetApi.id}</code>
            <span className="text-gray-400">— Create rows</span>
          </div>
          <div className="flex gap-3">
            <span className="bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded text-xs font-mono font-bold w-16 text-center">
              PATCH
            </span>
            <code className="text-gray-600">
              /{sheetApi.id}/:col/:val
            </code>
            <span className="text-gray-400">— Update</span>
          </div>
          <div className="flex gap-3">
            <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded text-xs font-mono font-bold w-16 text-center">
              DELETE
            </span>
            <code className="text-gray-600">
              /{sheetApi.id}/:col/:val
            </code>
            <span className="text-gray-400">— Delete</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsTab({
  sheetApi,
  onUpdate,
}: {
  sheetApi: any;
  onUpdate: () => void;
}) {
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
        name,
        allowRead,
        allowCreate,
        allowUpdate,
        allowDelete,
        cacheTtlSeconds: cacheTtl,
        rateLimitRpm,
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
    <div className="bg-white rounded-lg shadow p-6 max-w-lg space-y-5">
      {msg && (
        <div
          className={`text-sm rounded p-3 ${
            msg.includes("saved")
              ? "bg-green-50 text-green-600"
              : "bg-red-50 text-red-600"
          }`}
        >
          {msg}
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full border rounded-md px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Permissions
        </label>
        <div className="space-y-2">
          {[
            { label: "Read", value: allowRead, set: setAllowRead },
            { label: "Create", value: allowCreate, set: setAllowCreate },
            { label: "Update", value: allowUpdate, set: setAllowUpdate },
            { label: "Delete", value: allowDelete, set: setAllowDelete },
          ].map((perm) => (
            <label key={perm.label} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={perm.value}
                onChange={(e) => perm.set(e.target.checked)}
                className="rounded"
              />
              {perm.label}
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Cache TTL (seconds)
        </label>
        <input
          type="number"
          value={cacheTtl}
          onChange={(e) => setCacheTtl(Number(e.target.value))}
          min={0}
          className="w-full border rounded-md px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Rate Limit (requests/min)
        </label>
        <input
          type="number"
          value={rateLimitRpm}
          onChange={(e) => setRateLimitRpm(Number(e.target.value))}
          min={1}
          className="w-full border rounded-md px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Bearer Token (optional)
        </label>
        <input
          type="text"
          value={bearerToken}
          onChange={(e) => setBearerToken(e.target.value)}
          className="w-full border rounded-md px-3 py-2 text-sm font-mono"
          placeholder="Leave empty for public access"
        />
        <p className="text-xs text-gray-400 mt-1">
          If set, requests must include Authorization: Bearer &lt;token&gt;
        </p>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save Settings"}
      </button>
    </div>
  );
}

function KeysTab({
  sheetApi,
  onUpdate,
}: {
  sheetApi: any;
  onUpdate: () => void;
}) {
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
    if (confirm("Revoke this API key?")) {
      await api.deleteApiKey(sheetApi.id, keyId);
      onUpdate();
    }
  };

  return (
    <div className="space-y-4 max-w-lg">
      <div className="bg-white rounded-lg shadow p-5">
        <h2 className="font-semibold mb-3">Create API Key</h2>
        <div className="flex gap-2">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="flex-1 border rounded-md px-3 py-2 text-sm"
            placeholder="Label (optional)"
          />
          <button
            onClick={handleCreate}
            disabled={creating}
            className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </div>

      {sheetApi.apiKeys && sheetApi.apiKeys.length > 0 ? (
        <div className="bg-white rounded-lg shadow divide-y">
          {sheetApi.apiKeys.map((k: any) => (
            <div key={k.id} className="p-4 flex items-center justify-between">
              <div>
                <code className="text-sm font-mono bg-gray-100 px-2 py-1 rounded">
                  {k.key}
                </code>
                {k.label && (
                  <span className="ml-2 text-xs text-gray-500">{k.label}</span>
                )}
                <div className="text-xs text-gray-400 mt-1">
                  Created {new Date(k.createdAt).toLocaleDateString()}
                </div>
              </div>
              <button
                onClick={() => handleDelete(k.id)}
                className="text-red-500 text-xs hover:underline"
              >
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
    api
      .getUsage(apiId)
      .then(setUsage)
      .finally(() => setLoading(false));
  }, [apiId]);

  if (loading) return <div className="text-gray-500">Loading usage...</div>;
  if (!usage) return <div className="text-gray-500">No data.</div>;

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow p-5">
        <h2 className="font-semibold mb-2">Total Requests</h2>
        <p className="text-3xl font-bold">{usage.total}</p>
        <p className="text-xs text-gray-400">
          Showing last {usage.days} days ({usage.recent.length} recent)
        </p>
      </div>

      {usage.recent.length > 0 && (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs">
              <tr>
                <th className="text-left px-4 py-2">Method</th>
                <th className="text-left px-4 py-2">Path</th>
                <th className="text-left px-4 py-2">Status</th>
                <th className="text-left px-4 py-2">Time</th>
                <th className="text-left px-4 py-2">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {usage.recent.map((log: any, i: number) => (
                <tr key={i}>
                  <td className="px-4 py-2 font-mono text-xs">{log.method}</td>
                  <td className="px-4 py-2 font-mono text-xs truncate max-w-[200px]">
                    {log.path}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`text-xs font-medium ${
                        log.statusCode < 400
                          ? "text-green-600"
                          : "text-red-600"
                      }`}
                    >
                      {log.statusCode}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500">
                    {log.responseMs}ms
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-400">
                    {new Date(log.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
