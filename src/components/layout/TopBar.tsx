'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface TopBarProps {
  user: { name: string; email: string };
}

export function TopBar({ user }: TopBarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [showConfirm, setShowConfirm] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const nav = [
    { href: '/', label: 'Optag', exact: true },
    { href: '/arkiv', label: 'Arkiv' },
    { href: '/settings/data', label: 'Data' },
  ];

  // e.g. /meeting/abc123/review
  const reviewMatch = pathname.match(/^\/meeting\/([^/]+)\/review$/);
  const reviewMeetingId = reviewMatch?.[1] ?? null;

  function isActive(href: string, exact?: boolean) {
    if (exact) return pathname === href;
    return pathname.startsWith(href);
  }

  function handleNavClick(e: React.MouseEvent, href: string) {
    if (reviewMeetingId && href === '/') {
      e.preventDefault();
      setPendingHref(href);
      setShowConfirm(true);
    }
  }

  async function confirmDeleteAndNavigate() {
    if (!reviewMeetingId || !pendingHref) return;
    setDeleting(true);
    try {
      await fetch(`/api/meetings/${reviewMeetingId}/audio`, { method: 'DELETE' });
    } finally {
      setDeleting(false);
    }
    setShowConfirm(false);
    router.push(pendingHref);
  }

  function cancelConfirm() {
    setShowConfirm(false);
    setPendingHref(null);
  }

  async function handleSignOut() {
    await fetch('/api/auth/sign-out', { method: 'POST' });
    window.location.href = '/login';
  }

  return (
    <>
      <Dialog open={showConfirm} onOpenChange={(open) => { if (!open) cancelConfirm(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Slet lydfil og forlad mødet?</DialogTitle>
          </DialogHeader>
          <p style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.6 }}>
            Lydfilen slettes, og mødet nulstilles til optagelse. Du kan derefter starte en ny optagelse.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={cancelConfirm} disabled={deleting}>
              Afbryd
            </Button>
            <Button variant="destructive" onClick={confirmDeleteAndNavigate} disabled={deleting}>
              {deleting ? 'Sletter…' : 'Slet og forlad'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
          onClick={(e) => handleNavClick(e, '/')}
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
                onClick={(e) => handleNavClick(e, item.href)}
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
    </>
  );
}
