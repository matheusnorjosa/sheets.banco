"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

interface SheetApi {
  id: string;
  name: string;
  spreadsheetId: string;
  createdAt: string;
  _count: { apiKeys: number; usageLogs: number };
}

export default function ApisPage() {
  const { user, refreshUser } = useAuth();
  const searchParams = useSearchParams();
  const [apis, setApis] = useState<SheetApi[]>([]);
  const [loading, setLoading] = useState(true);
  const googleStatus = searchParams.get("google");

  useEffect(() => {
    if (googleStatus === "connected") {
      refreshUser();
    }
  }, [googleStatus]);

  useEffect(() => {
    api
      .listApis()
      .then((data) => setApis(data.apis))
      .finally(() => setLoading(false));
  }, []);

  const handleAuthorizeGoogle = () => {
    const token = localStorage.getItem("token");
    // Open the OAuth flow — the backend will redirect to Google
    window.location.href = `${API_URL}/auth/google?token=${token}`;
  };

  if (loading) {
    return <div className="text-gray-500">Loading APIs...</div>;
  }

  return (
    <div>
      {/* Google connection status */}
      {googleStatus === "connected" && (
        <div className="bg-green-50 border border-green-200 text-green-700 rounded-md p-3 mb-4 text-sm">
          Google account connected successfully!
        </div>
      )}
      {googleStatus === "error" && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-md p-3 mb-4 text-sm">
          Failed to connect Google account. Please try again.
        </div>
      )}

      {/* Authorize Google banner */}
      {user && !user.googleConnected && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-md p-4 mb-6 flex items-center justify-between">
          <div>
            <p className="font-medium text-yellow-800 text-sm">
              Connect your Google account
            </p>
            <p className="text-yellow-700 text-xs mt-1">
              Authorize access to your Google Sheets to create APIs.
            </p>
          </div>
          <button
            onClick={handleAuthorizeGoogle}
            className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700"
          >
            Authorize
          </button>
        </div>
      )}

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
