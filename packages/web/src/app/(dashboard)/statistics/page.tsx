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

      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <div className="bg-[#16213e] border border-[#2a2a4a] rounded-lg p-6">
          <p className="text-sm text-gray-500 mb-1">Total Requests</p>
          <p className="text-3xl font-bold text-white">{totalRequests.toLocaleString()}</p>
        </div>

        <div className="bg-[#16213e] border border-[#2a2a4a] rounded-lg p-6">
          <p className="text-sm text-gray-500 mb-1">Spreadsheet APIs</p>
          <p className="text-3xl font-bold text-white">{apis.length}</p>
        </div>

        <div className="bg-[#16213e] border border-[#2a2a4a] rounded-lg p-6">
          <p className="text-sm text-gray-500 mb-1">API Keys</p>
          <p className="text-3xl font-bold text-white">
            {apis.reduce((sum, a) => sum + (a._count?.apiKeys ?? 0), 0)}
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
