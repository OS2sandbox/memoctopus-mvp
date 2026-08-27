'use client';

import React, { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { DeleteAudioDialog } from '@/components/meeting/DeleteAudioDialog';
import { useIsMobile } from '@/lib/use-is-mobile';
import { signOut, useSession } from '@/lib/auth-client';
import { useReviewAudio } from '@/lib/review-audio-context';

export function TopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const isMobile = useIsMobile();
  const [showConfirm, setShowConfirm] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const { data: session } = useSession();
  const { hasAudio } = useReviewAudio();
  const [isPending, startTransition] = useTransition();

  const nav = [
    { href: '/dashboard', label: 'Optag', exact: true },
    { href: '/arkiv', label: 'Arkiv' },
  ];

  const reviewMeetingId = useMemo(
    () => pathname.match(/^\/meeting\/([^/]+)\/review$/)?.[1] ?? null,
    [pathname],
  );

  function isActive(href: string, exact?: boolean) {
    if (exact) return pathname === href;
    return pathname.startsWith(href);
  }

  function navigate(href: string) {
    startTransition(() => {
      router.push(href);
    });
  }

  function handleNavClick(e: React.MouseEvent, href: string) {
    e.preventDefault();
    if (reviewMeetingId && hasAudio) {
      setPendingHref(href);
      setShowConfirm(true);
      return;
    }
    navigate(href);
  }

  return (
    <>
      {reviewMeetingId && hasAudio && (
        <DeleteAudioDialog
          open={showConfirm}
          onOpenChange={(open) => {
            setShowConfirm(open);
            if (!open) setPendingHref(null);
          }}
          meetingId={reviewMeetingId}
          title="Slet lydfil og forlad mødet?"
          confirmLabel="Slet og forlad"
          onDeleted={() => navigate(pendingHref ?? '/dashboard')}
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
                  opacity: isPending ? 0.5 : 1,
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
              onClick={() => signOut().then(() => router.push('/'))}
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

      {isPending && (
        <div style={{
          position: 'fixed', top: 56, left: 0, right: 0,
          height: 2, zIndex: 50, overflow: 'hidden',
          background: 'var(--line)',
        }}>
          <div style={{
            height: '100%',
            background: 'var(--accent)',
            animation: 'navBarSlide 1.2s ease-in-out infinite',
          }} />
          <style>{`
            @keyframes navBarSlide {
              0%   { margin-left: -60%; width: 60%; }
              100% { margin-left: 100%; width: 60%; }
            }
          `}</style>
        </div>
      )}
    </>
  );
}
