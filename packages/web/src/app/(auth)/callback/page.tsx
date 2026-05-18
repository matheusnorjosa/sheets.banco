"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";

function CallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { refreshUser } = useAuth();

  useEffect(() => {
    const token = searchParams.get("token");
    const google = searchParams.get("google");

    if (!token) {
      router.replace("/login?google=error");
      return;
    }

    api.setToken(token);

    // Sync the AuthProvider state with the new token BEFORE navigating into
    // the dashboard. The previous code only persisted the token and trusted
    // soft-navigation to re-trigger AuthProvider's mount-time useEffect —
    // but the provider lives in the root layout and stays mounted, so the
    // dashboard guard saw user=null and bounced back to /login on the first
    // try. Awaiting refreshUser() makes the first attempt deterministic.
    let cancelled = false;
    refreshUser()
      .then(() => {
        if (!cancelled) router.replace("/apis?google=" + (google || "connected"));
      })
      .catch(() => {
        if (!cancelled) router.replace("/login?google=error");
      });
    return () => { cancelled = true; };
    // refreshUser is captured from the AuthProvider closure; it does not
    // depend on any prop/state we read here, so we intentionally omit it
    // from the deps array to avoid re-running on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, router]);

  return null;
}

export default function CallbackPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--background)]">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-[var(--accent)] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="text-[var(--text-tertiary)] text-sm">Entrando...</p>
      </div>
      <Suspense>
        <CallbackHandler />
      </Suspense>
    </div>
  );
}
