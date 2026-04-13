"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";

export default function RegisterPage() {
  const { register } = useAuth();
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await register(email, password, name || undefined);
      router.push("/apis");
    } catch (err: any) {
      setError(err.message || "Registration failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#1a1a2e] px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center mb-6">
          <div className="w-12 h-12 bg-[#4f46e5] rounded-xl flex items-center justify-center text-white font-bold text-xl">
            S
          </div>
        </div>
        <h1 className="text-2xl font-bold text-center text-white mb-1">sheets.banco</h1>
        <p className="text-gray-500 text-center mb-8 text-sm">Create your account</p>

        <form onSubmit={handleSubmit} className="bg-[#16213e] border border-[#2a2a4a] rounded-lg p-6 space-y-4">
          {error && (
            <div className="bg-red-900/30 border border-red-700 text-red-400 text-sm rounded-lg p-3">{error}</div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Name (optional)</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="w-full bg-[#1e1e3a] border border-[#3a3a5a] rounded-lg px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-[#4f46e5]" placeholder="Your name" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="w-full bg-[#1e1e3a] border border-[#3a3a5a] rounded-lg px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-[#4f46e5]" placeholder="you@example.com" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} className="w-full bg-[#1e1e3a] border border-[#3a3a5a] rounded-lg px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-[#4f46e5]" placeholder="Min. 6 characters" />
          </div>

          <button type="submit" disabled={loading} className="w-full bg-[#4f46e5] text-white rounded-lg py-2.5 text-sm font-medium hover:bg-[#4338ca] disabled:opacity-50 transition-colors">
            {loading ? "Creating account..." : "Create account"}
          </button>
        </form>

        <p className="text-center text-sm text-gray-500 mt-4">
          Already have an account?{" "}
          <Link href="/login" className="text-[#818cf8] hover:underline">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
