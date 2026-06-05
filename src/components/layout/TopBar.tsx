'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { DeleteAudioDialog } from '@/components/meeting/DeleteAudioDialog';
import { useIsMobile } from '@/lib/use-is-mobile';
import { signOut, useSession } from '@/lib/auth-client';

export function TopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const isMobile = useIsMobile();
  const [showConfirm, setShowConfirm] = useState(false);
  const { data: session } = useSession();

  const nav = [
    { href: '/dashboard', label: 'Optag', exact: true },
    { href: '/arkiv', label: 'Arkiv' },
    { href: '/settings/data', label: 'Data' },
  ];

  const reviewMeetingId = useMemo(
    () => pathname.match(/^\/meeting\/([^/]+)\/review$/)?.[1] ?? null,
    [pathname],
  );

  function isActive(href: string, exact?: boolean) {
    if (exact) return pathname === href;
    return pathname.startsWith(href);
  }

  function handleNavClick(e: React.MouseEvent, href: string) {
    if (reviewMeetingId && href === '/dashboard') {
      e.preventDefault();
      setShowConfirm(true);
    }
  }

  return (
    <>
      {reviewMeetingId && (
        <DeleteAudioDialog
          open={showConfirm}
          onOpenChange={setShowConfirm}
          meetingId={reviewMeetingId}
          title="Slet lydfil og forlad mødet?"
          confirmLabel="Slet og forlad"
          onDeleted={() => router.push('/dashboard')}
        />
      )}

      <header style={{
        position: 'sticky', top: 0, zIndex: 40,
        height: 56, borderBottom: '1px solid var(--line)',
        background: 'var(--bg)',
        display: 'flex', alignItems: 'center',
        padding: isMobile ? '0 16px' : '0 32px', gap: isMobile ? 16 : 28,
      }}>
        {/* Wordmark */}
        <Link
          href="/dashboard"
          onClick={(e) => handleNavClick(e, '/dashboard')}
          style={{
            fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 14,
            letterSpacing: '-0.03em', color: 'var(--ink)',
            textDecoration: 'none', flexShrink: 0,
          }}
        >
          memoctopus<span style={{ color: 'var(--accent)', padding: '0 5px' }}>·</span>referat
        </Link>

        {/* Nav */}
        <nav style={{ display: 'flex', gap: isMobile ? 16 : 22, marginLeft: isMobile ? 0 : 28 }}>
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

        {/* User / sign-out */}
        {session?.user && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
            {!isMobile && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)' }}>
                {session.user.email}
              </span>
            )}
            <button
              type="button"
              onClick={() => signOut().finally(() => router.push('/'))}
              style={{
                fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)',
                background: 'none', border: '1px solid var(--line)', borderRadius: 4,
                padding: '3px 10px', cursor: 'pointer',
              }}
            >
              log ud
            </button>
          </div>
        )}
      </header>
    </>
  );
}
