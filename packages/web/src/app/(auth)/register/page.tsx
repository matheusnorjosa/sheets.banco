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
      setError(err.message || "Falha ao criar conta");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--background)] px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center mb-4">
          <img src="/logo.png" alt="sheets.banco" className="h-20 w-auto" />
        </div>
        <h1 className="text-2xl font-bold text-center text-[var(--accent)] mb-1.5">sheets.banco</h1>
        <p className="text-[var(--accent-light)] text-center mb-10 text-sm">Crie sua conta</p>

        <form onSubmit={handleSubmit} className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-6 space-y-4">
          {error && (
            <div className="bg-red-900/30 border border-red-700 text-red-400 text-sm rounded-lg p-3">{error}</div>
          )}

          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">Nome (opcional)</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="w-full bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg px-3 py-2.5 text-sm text-[var(--text-secondary)] placeholder-gray-500 focus:outline-none focus:border-[var(--accent)]" placeholder="Seu nome" />
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">E-mail</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="w-full bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg px-3 py-2.5 text-sm text-[var(--text-secondary)] placeholder-gray-500 focus:outline-none focus:border-[var(--accent)]" placeholder="voce@exemplo.com" />
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">Senha</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} className="w-full bg-[var(--input-bg)] border border-[var(--input-border)] rounded-lg px-3 py-2.5 text-sm text-[var(--text-secondary)] placeholder-gray-500 focus:outline-none focus:border-[var(--accent)]" placeholder="Mín. 6 caracteres" />
          </div>

          <button type="submit" disabled={loading} className="w-full bg-[var(--accent)] text-white rounded-lg py-2.5 text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors">
            {loading ? "Criando conta..." : "Criar conta"}
          </button>
        </form>

        <p className="text-center text-sm text-[var(--text-muted)] mt-4">
          Já tem uma conta?{" "}
          <Link href="/login" className="text-[var(--accent-light)] hover:underline">Entrar</Link>
        </p>
      </div>
    </div>
  );
}
