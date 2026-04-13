"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";

export default function NewApiPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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
      <h1 className="text-2xl font-bold mb-6">Connect a Google Sheet</h1>

      <div className="bg-yellow-50 border border-yellow-200 rounded-md p-4 mb-6 text-sm text-yellow-800">
        <p className="font-medium mb-1">Before connecting:</p>
        <p>
          Share your Google Sheet with the service account email address. The
          sheet must be accessible by the service account to work.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-lg shadow p-6 space-y-4"
      >
        {error && (
          <div className="bg-red-50 text-red-600 text-sm rounded p-3">
            {error}
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            API Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="e.g. Products, Users, Orders"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Google Sheet URL
          </label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            className="w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="https://docs.google.com/spreadsheets/d/..."
          />
          <p className="text-xs text-gray-400 mt-1">
            Paste the full URL of your Google Sheet
          </p>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-blue-600 text-white rounded-md py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Connecting..." : "Connect Sheet"}
        </button>
      </form>
    </div>
  );
}
