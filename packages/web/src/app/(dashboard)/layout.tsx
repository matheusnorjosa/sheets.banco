"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";

const navItems = [
  {
    href: "/apis",
    label: "Your APIs",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    ),
  },
  {
    href: "/statistics",
    label: "Statistics",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [user, loading, router]);

  if (loading || !user) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#1a1a2e]">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-[#1a1a2e]">
      {/* Sidebar */}
      <aside className="w-16 bg-[#0f0f23] flex flex-col items-center py-4 border-r border-[#2a2a4a]">
        {/* Logo */}
        <Link href="/apis" className="mb-8 group" title="sheets.banco">
          <div className="w-10 h-10 bg-[#4f46e5] rounded-lg flex items-center justify-center text-white font-bold text-lg group-hover:bg-[#4338ca] transition-colors">
            S
          </div>
        </Link>

        {/* Nav icons */}
        <nav className="flex-1 flex flex-col items-center gap-2">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
                pathname.startsWith(item.href)
                  ? "bg-[#4f46e5] text-white"
                  : "text-gray-500 hover:bg-[#16213e] hover:text-gray-300"
              }`}
            >
              {item.icon}
            </Link>
          ))}
        </nav>

        {/* User avatar / logout */}
        <div className="mt-auto flex flex-col items-center gap-3">
          <button
            onClick={() => {
              logout();
              router.push("/login");
            }}
            title="Sign out"
            className="w-10 h-10 rounded-lg flex items-center justify-center text-gray-500 hover:bg-[#16213e] hover:text-gray-300 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
          <div
            className="w-8 h-8 rounded-full bg-[#4f46e5] flex items-center justify-center text-white text-xs font-bold"
            title={user.email}
          >
            {user.email[0].toUpperCase()}
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 p-8 overflow-auto">{children}</main>
    </div>
  );
}
