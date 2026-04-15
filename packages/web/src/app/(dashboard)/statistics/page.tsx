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

  if (loading) return <div className="text-[var(--text-tertiary)]">Carregando estatísticas...</div>;

  return (
    <div>
      <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-1">Estatísticas e uso</h1>
      <p className="text-[var(--text-muted)] text-sm mb-6">De todas as suas APIs.</p>

      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-6">
          <p className="text-sm text-[var(--text-muted)] mb-1">Total de Requisições</p>
          <p className="text-3xl font-bold text-[var(--text-primary)]">{totalRequests.toLocaleString()}</p>
        </div>

        <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-6">
          <p className="text-sm text-[var(--text-muted)] mb-1">APIs de Planilhas</p>
          <p className="text-3xl font-bold text-[var(--text-primary)]">{apis.length}</p>
        </div>

        <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-6">
          <p className="text-sm text-[var(--text-muted)] mb-1">Chaves de API</p>
          <p className="text-3xl font-bold text-[var(--text-primary)]">
            {apis.reduce((sum, a) => sum + (a._count?.apiKeys ?? 0), 0)}
          </p>
        </div>
      </div>

      {apis.length > 0 && (
        <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[var(--sidebar-bg)] text-[var(--text-muted)] text-xs">
              <tr>
                <th className="text-left px-4 py-2.5">Nome da API</th>
                <th className="text-left px-4 py-2.5">Requisições</th>
                <th className="text-left px-4 py-2.5">Chaves de API</th>
                <th className="text-left px-4 py-2.5">Criado em</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--card-border)]">
              {apis.map((a) => (
                <tr key={a.id} className="hover:bg-[var(--input-bg)]">
                  <td className="px-4 py-2.5 text-[var(--text-primary)] font-medium">{a.name}</td>
                  <td className="px-4 py-2.5 text-[var(--text-tertiary)]">{a._count?.usageLogs ?? 0}</td>
                  <td className="px-4 py-2.5 text-[var(--text-tertiary)]">{a._count?.apiKeys ?? 0}</td>
                  <td className="px-4 py-2.5 text-[var(--text-muted)] text-xs">{new Date(a.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
