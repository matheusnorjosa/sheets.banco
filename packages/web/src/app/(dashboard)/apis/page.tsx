"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api-client";

interface SheetApi {
  id: string;
  name: string;
  spreadsheetId: string;
  createdAt: string;
  _count: { apiKeys: number; usageLogs: number };
}

export default function ApisPage() {
  const [apis, setApis] = useState<SheetApi[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .listApis()
      .then((data) => setApis(data.apis))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-gray-500">Loading APIs...</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">My APIs</h1>
        <Link
          href="/apis/new"
          className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700"
        >
          + Connect Sheet
        </Link>
      </div>

      {apis.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <p className="text-gray-500 mb-4">
            You don&apos;t have any APIs yet.
          </p>
          <Link
            href="/apis/new"
            className="text-blue-600 hover:underline text-sm"
          >
            Connect your first Google Sheet
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {apis.map((item) => (
            <Link
              key={item.id}
              href={`/apis/${item.id}`}
              className="bg-white rounded-lg shadow p-5 hover:shadow-md transition-shadow"
            >
              <h2 className="font-semibold text-lg mb-1">{item.name}</h2>
              <p className="text-xs text-gray-400 font-mono mb-3 truncate">
                {item.id}
              </p>
              <div className="flex gap-4 text-xs text-gray-500">
                <span>{item._count.usageLogs} requests</span>
                <span>{item._count.apiKeys} keys</span>
              </div>
              <div className="text-xs text-gray-400 mt-2">
                Created {new Date(item.createdAt).toLocaleDateString()}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
