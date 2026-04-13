"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";

export default function StatisticsPage() {
  const [apis, setApis] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalRequests, setTotalRequests] = useState(0);

  useEffect(() => {
    api.listApis().then(async (data) => {
      setApis(data.apis);
      let total = 0;
      for (const a of data.apis) {
        total += a._count?.usageLogs ?? 0;
      }
      setTotalRequests(total);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="text-gray-400">Loading statistics...</div>;

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-1">Statistics and usage</h1>
      <p className="text-gray-500 text-sm mb-6">For all your APIs.</p>

      <div className="grid gap-4 sm:grid-cols-2 mb-6">
        <div className="bg-[#16213e] border border-[#2a2a4a] rounded-lg p-6">
          <h2 className="font-semibold text-white mb-3">Usage in this month</h2>
          <div className="w-full bg-[#2a2a4a] rounded-full h-2 mb-3">
            <div
              className="bg-[#4f46e5] h-2 rounded-full transition-all"
              style={{ width: `${Math.min((totalRequests / 500) * 100, 100)}%` }}
            />
          </div>
          <p className="text-sm text-gray-400">
            Current usage: <span className="text-white font-medium">{totalRequests}</span> requests.{" "}
            <span className="text-green-400">({Math.round((totalRequests / 500) * 100)}%)</span>
          </p>
        </div>

        <div className="bg-[#16213e] border border-[#2a2a4a] rounded-lg p-6">
          <h2 className="font-semibold text-white mb-3">Spreadsheet APIs</h2>
          <div className="w-full bg-[#2a2a4a] rounded-full h-2 mb-3">
            <div
              className="bg-[#4f46e5] h-2 rounded-full transition-all"
              style={{ width: `${Math.min((apis.length / 10) * 100, 100)}%` }}
            />
          </div>
          <p className="text-sm text-gray-400">
            You have <span className="text-white font-medium">{apis.length}</span> spreadsheet APIs.{" "}
            <span className="text-green-400">({Math.round((apis.length / 10) * 100)}%)</span>
          </p>
        </div>
      </div>

      {apis.length > 0 && (
        <div className="bg-[#16213e] border border-[#2a2a4a] rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[#0f0f23] text-gray-500 text-xs">
              <tr>
                <th className="text-left px-4 py-2.5">API Name</th>
                <th className="text-left px-4 py-2.5">Requests</th>
                <th className="text-left px-4 py-2.5">API Keys</th>
                <th className="text-left px-4 py-2.5">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2a2a4a]">
              {apis.map((a) => (
                <tr key={a.id} className="hover:bg-[#1e1e3a]">
                  <td className="px-4 py-2.5 text-white font-medium">{a.name}</td>
                  <td className="px-4 py-2.5 text-gray-400">{a._count?.usageLogs ?? 0}</td>
                  <td className="px-4 py-2.5 text-gray-400">{a._count?.apiKeys ?? 0}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs">{new Date(a.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
