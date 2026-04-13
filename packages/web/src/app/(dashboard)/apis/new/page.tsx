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
      <h1 className="text-2xl font-bold text-white mb-1">Connect a Google Sheet</h1>
      <p className="text-gray-500 text-sm mb-6">
        Paste the URL of your Google Sheet to create an API.
      </p>

      {user && !user.googleConnected && (
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 mb-6 flex items-center justify-between">
          <span className="text-gray-300 text-sm">
            You need to authorize Google access first.
          </span>
          <button
            onClick={handleAuthorizeGoogle}
            className="bg-[#4f46e5] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#4338ca]"
          >
            Authorize
          </button>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="bg-[#16213e] border border-[#2a2a4a] rounded-lg p-6 space-y-4"
      >
        {error && (
          <div className="bg-red-900/30 border border-red-700 text-red-400 text-sm rounded-lg p-3">
            {error}
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1.5">
            API Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full bg-[#1e1e3a] border border-[#3a3a5a] rounded-lg px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-[#4f46e5]"
            placeholder="e.g. Products, Users, Orders"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1.5">
            Google Sheet URL
          </label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            className="w-full bg-[#1e1e3a] border border-[#3a3a5a] rounded-lg px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-[#4f46e5]"
            placeholder="https://docs.google.com/spreadsheets/d/..."
          />
          <p className="text-xs text-gray-500 mt-1.5">
            Paste the full URL of your Google Sheet
          </p>
        </div>

        <button
          type="submit"
          disabled={loading || !!(user && !user.googleConnected)}
          className="w-full bg-[#4f46e5] text-white rounded-lg py-2.5 text-sm font-medium hover:bg-[#4338ca] disabled:opacity-50 transition-colors"
        >
          {loading ? "Connecting..." : "Connect Sheet"}
        </button>
      </form>
    </div>
  );
}
