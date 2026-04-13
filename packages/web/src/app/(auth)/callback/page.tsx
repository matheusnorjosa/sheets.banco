"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api-client";

function CallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const token = searchParams.get("token");
    const google = searchParams.get("google");

    if (token) {
      api.setToken(token);
      router.replace("/apis?google=" + (google || "connected"));
    } else {
      router.replace("/login?google=error");
    }
  }, [searchParams, router]);

  return null;
}

export default function CallbackPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#1a1a2e]">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-[#4f46e5] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="text-gray-400 text-sm">Signing you in...</p>
      </div>
      <Suspense>
        <CallbackHandler />
      </Suspense>
    </div>
  );
}
