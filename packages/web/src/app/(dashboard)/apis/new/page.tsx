"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

export default function NewApiPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleAuthorizeGoogle = () => {
    const token = localStorage.getItem("token");
    window.location.href = `${API_URL}/auth/google?token=${token}`;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const data = await api.createApi(name, url);
      router.push(`/apis/${data.api.id}`);
    } catch (err: any) {
      setError(err.message || "Failed to connect sheet");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-1">Connect a Google Sheet</h1>
      <p className="text-[var(--text-muted)] text-sm mb-6">
        Paste the URL of your Google Sheet to create an API.
      </p>

      {user && !user.googleConnected && (
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 mb-6 flex items-center justify-between">
          <span className="text-[var(--text-secondary)] text-sm">
            You need to authorize Google access first.
          </span>
          <button
            onClick={handleAuthorizeGoogle}
            className="bg-[var(--accent)] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)]"
          >
            Authorize
          </button>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-6 space-y-4"
      >
        {error && (
          <div className="bg-red-900/30 border border-red-700 text-red-400 text-sm rounded-lg p-3">
            {error}
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">
            API Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg px-3 py-2.5 text-sm text-[var(--text-secondary)] placeholder-gray-500 focus:outline-none focus:border-[var(--accent)]"
            placeholder="e.g. Products, Users, Orders"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">
            Google Sheet URL
          </label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            className="w-full bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg px-3 py-2.5 text-sm text-[var(--text-secondary)] placeholder-gray-500 focus:outline-none focus:border-[var(--accent)]"
            placeholder="https://docs.google.com/spreadsheets/d/..."
          />
          <p className="text-xs text-[var(--text-muted)] mt-1.5">
            Paste the full URL of your Google Sheet
          </p>
        </div>

        <button
          type="submit"
          disabled={loading || !!(user && !user.googleConnected)}
          className="w-full bg-[var(--accent)] text-white rounded-lg py-2.5 text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
        >
          {loading ? "Connecting..." : "Connect Sheet"}
        </button>
      </form>
    </div>
  );
}
