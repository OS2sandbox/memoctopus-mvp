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
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface TopBarProps {
  user: { name: string; email: string };
}

export function TopBar({ user }: TopBarProps) {
  const pathname = usePathname();

  const nav = [
    { href: '/', label: 'Optag', exact: true },
    { href: '/arkiv', label: 'Arkiv' },
    { href: '/templates', label: 'Skabeloner' },
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
    <header className="sticky top-0 z-40 border-b border-[var(--line)] bg-[var(--surface)]">
      <div className="mx-auto flex h-14 max-w-[1040px] items-center justify-between px-6">
        {/* Wordmark */}
        <Link
          href="/"
          className="shrink-0"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '17px',
            fontWeight: 500,
            letterSpacing: '-0.04em',
            color: 'var(--ink)',
            textDecoration: 'none',
          }}
        >
          memoctopus
          <span style={{ color: 'var(--accent)', margin: '0 0.25em' }}>·</span>
          referat
        </Link>

        {/* Nav */}
        <nav className="hidden md:flex items-center gap-0.5">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'px-3 py-1.5 rounded-[var(--radius)] text-sm transition-colors',
                isActive(item.href, item.exact)
                  ? 'bg-[var(--accent-wash)] text-[var(--accent-ink)] font-medium'
                  : 'text-[var(--ink-2)] hover:text-[var(--ink)] hover:bg-[var(--surface-2)]',
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        {/* User menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--surface-2)] text-xs font-semibold text-[var(--ink-2)] border border-[var(--line-strong)]">
                {user.name.charAt(0).toUpperCase()}
              </span>
              <span className="hidden md:block text-sm text-[var(--ink-2)]">
                {user.name}
              </span>
            </Button>
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
