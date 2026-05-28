'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface TopBarProps {
  user: { name: string; email: string };
}

export function TopBar({ user }: TopBarProps) {
  const pathname = usePathname();

  const nav = [
    { href: '/', label: 'Optag', exact: true },
    { href: '/arkiv', label: 'Arkiv' },
    { href: '/settings/data', label: 'Data' },
  ];

  function isActive(href: string, exact?: boolean) {
    if (exact) return pathname === href;
    return pathname.startsWith(href);
  }

  async function handleSignOut() {
    await fetch('/api/auth/sign-out', { method: 'POST' });
    window.location.href = '/login';
  }

  return (
    <header style={{
      position: 'sticky', top: 0, zIndex: 40,
      height: 56, borderBottom: '1px solid var(--line)',
      background: 'var(--bg)',
      display: 'flex', alignItems: 'center',
      padding: '0 32px', gap: 28,
    }}>
      {/* Wordmark */}
      <Link
        href="/"
        style={{
          fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 14,
          letterSpacing: '-0.03em', color: 'var(--ink)',
          textDecoration: 'none', flexShrink: 0,
        }}
      >
        memoctopus<span style={{ color: 'var(--accent)', padding: '0 5px' }}>·</span>referat
      </Link>

      {/* Nav */}
      <nav style={{ display: 'flex', gap: 22, marginLeft: 28 }}>
        {nav.map((item) => {
          const active = isActive(item.href, item.exact);
          return (
            <Link
              key={item.href}
              href={item.href}
              style={{
                fontSize: 13.5,
                color: active ? 'var(--ink)' : 'var(--muted)',
                fontWeight: active ? 500 : 400,
                textDecoration: 'none',
                transition: 'color 120ms',
              }}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* User menu */}
      <div style={{ marginLeft: 'auto' }}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '4px 0',
            }}>
              <span style={{
                width: 28, height: 28, borderRadius: 999,
                border: '1px solid var(--line-2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--ink-2)',
                flexShrink: 0,
              }}>
                {user.name.charAt(0).toUpperCase()}
              </span>
              <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>{user.name}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <div className="px-2 py-1.5">
              <p className="text-sm font-medium text-[var(--ink)]">{user.name}</p>
              <p className="text-xs text-[var(--muted)]">{user.email}</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/settings/data" className="cursor-pointer">
                Indstillinger
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-[var(--danger)] focus:text-[var(--danger)] focus:bg-[var(--danger-wash)]"
              onClick={handleSignOut}
            >
              Log ud
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
