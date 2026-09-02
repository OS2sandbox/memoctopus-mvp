import { Suspense } from 'react';
import { LogoMark } from '@/components/brand/logo-mark';
import { HeroForm } from '@/components/auth/hero-form';
import { emailPasswordEnabled, enabledAuthProviders } from '@/lib/auth/providers';

// The enabled login methods are read from env on every request. Without this
// the page would be prerendered at build time and the provider list — including
// the OIDC provider's display name — would be frozen into the RSC payload
// produced inside the Docker builder stage, where no OIDC_* vars exist.
export const dynamic = 'force-dynamic';

export default function SignInPage() {
  return (
    <div style={{
      display: 'flex',
      minHeight: '100vh',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg)',
      padding: 16,
      fontFamily: 'var(--font-geist-sans)',
    }}>
      <div style={{ width: '100%', maxWidth: 400, display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          <LogoMark size={28} />
          <span style={{
            fontFamily: 'var(--font-geist-mono)',
            fontWeight: 500,
            fontSize: 15,
            letterSpacing: '-0.03em',
            color: 'var(--ink)',
            whiteSpace: 'nowrap',
          }}>
            memoctopus<span style={{ color: 'var(--accent)', padding: '0 5px' }}>·</span>referat
          </span>
        </div>
        <div style={{
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          borderRadius: 12,
          padding: '32px 30px',
          boxShadow: '0 1px 2px rgba(17,17,17,0.04), 0 22px 56px -30px rgba(17,17,17,0.18)',
        }}>
          <Suspense>
            <HeroForm
              providers={enabledAuthProviders()}
              emailPasswordEnabled={emailPasswordEnabled()}
            />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
