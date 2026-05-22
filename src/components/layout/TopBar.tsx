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
    { href: '/dashboard', label: 'Oversigt' },
    { href: '/templates', label: 'Skabeloner' },
  ];

  async function handleSignOut() {
    await fetch('/api/auth/sign-out', { method: 'POST' });
    window.location.href = '/login';
  }

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--surface)]">
      <div className="mx-auto flex h-14 max-w-[960px] items-center justify-between px-4">
        {/* Logo */}
        <Link href="/dashboard" className="flex items-center gap-2">
          <span className="text-base font-semibold text-[var(--text)]">Referat</span>
        </Link>

        {/* Nav */}
        <nav className="hidden md:flex items-center gap-1">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'px-3 py-1.5 rounded-[var(--radius)] text-sm transition-colors',
                pathname.startsWith(item.href)
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-medium'
                  : 'text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]',
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
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent-soft)] text-xs font-semibold text-[var(--accent)]">
                {user.name.charAt(0).toUpperCase()}
              </span>
              <span className="hidden md:block text-sm text-[var(--text-2)]">
                {user.name}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <div className="px-2 py-1.5">
              <p className="text-sm font-medium text-[var(--text)]">{user.name}</p>
              <p className="text-xs text-[var(--text-muted)]">{user.email}</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-[var(--danger)] focus:text-[var(--danger)] focus:bg-red-50"
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
