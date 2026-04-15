"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useOnboarding } from "@/lib/onboarding";

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
  const [search, setSearch] = useState("");
  const googleStatus = searchParams.get("google");

  useOnboarding();

  useEffect(() => {
    // Handle Google login: save JWT token from URL
    const tokenFromUrl = searchParams.get("token");
    if (tokenFromUrl) {
      api.setToken(tokenFromUrl);
      refreshUser();
      // Clean URL
      window.history.replaceState({}, "", "/apis?google=connected");
    }
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
    window.location.href = `${API_URL}/auth/google?token=${token}`;
  };

  const filtered = apis.filter((a) =>
    a.name.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) {
    return <div className="text-[var(--text-tertiary)]">Loading APIs...</div>;
  }

  return (
    <div>
      {/* Google connection banners */}
      {googleStatus === "connected" && (
        <div className="bg-green-900/30 border border-green-700 text-green-400 rounded-lg p-3 mb-4 text-sm">
          Google account connected successfully!
        </div>
      )}
      {googleStatus === "error" && (
        <div className="bg-red-900/30 border border-red-700 text-red-400 rounded-lg p-3 mb-4 text-sm">
          Failed to connect Google account. Please try again.
        </div>
      )}

      {/* Authorize Google banner */}
      {user && !user.googleConnected && (
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <span className="text-[var(--text-secondary)] text-sm">
              To use sheets.banco, we need access to your Google Sheets. Please click &quot;Authorize&quot; to grant permission.
            </span>
          </div>
          <button
            onClick={handleAuthorizeGoogle}
            className="bg-[var(--accent)] text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors whitespace-nowrap"
          >
            Authorize
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">APIs</h1>
          <p className="text-[var(--text-muted)] text-sm">A list of all your APIs.</p>
        </div>
        <Link
          href="/apis/new"
          data-onboard="create-api"
          className="bg-[var(--accent)] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors flex items-center gap-2"
        >
          <span>+</span> Create new API
        </Link>
      </div>

      {/* Search */}
      <div className="relative mb-6 mt-4">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder='Search your APIs (Press "/" to focus)'
          className="w-full max-w-md bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg pl-10 pr-4 py-2.5 text-sm text-[var(--text-secondary)] placeholder-gray-500 focus:outline-none focus:border-[var(--accent)] transition-colors"
        />
      </div>

      {/* API list */}
      {filtered.length === 0 ? (
        <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-12 text-center">
          <div className="w-12 h-12 mx-auto mb-4 rounded-lg border-2 border-dashed border-[var(--card-border)] flex items-center justify-center">
            <span className="text-2xl text-[var(--text-muted)]">+</span>
          </div>
          <p className="text-[var(--text-tertiary)] font-medium mb-1">No APIs</p>
          <p className="text-[var(--text-muted)] text-sm mb-4">
            Get started by creating a new API.
          </p>
          <Link
            href="/apis/new"
            className="inline-flex items-center gap-2 bg-[var(--accent)] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors"
          >
            <span>+</span> Create new API
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((item) => (
            <Link
              key={item.id}
              href={`/apis/${item.id}`}
              className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-5 hover:border-[var(--accent)] transition-colors group"
            >
              <h2 className="font-semibold text-[var(--text-primary)] text-lg mb-1 group-hover:text-[var(--accent-light)]">
                {item.name}
              </h2>
              <p className="text-xs text-[var(--text-muted)] font-mono mb-3 truncate">
                {item.id}
              </p>
              <div className="flex gap-4 text-xs text-[var(--text-muted)]">
                <span className="flex items-center gap-1">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  {item._count.usageLogs} requests
                </span>
                <span className="flex items-center gap-1">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                  </svg>
                  {item._count.apiKeys} keys
                </span>
              </div>
              <div className="text-xs text-[var(--text-faint)] mt-3">
                Created {new Date(item.createdAt).toLocaleDateString()}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
