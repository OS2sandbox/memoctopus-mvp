'use client';

import { useState } from 'react';
import { signIn, signUp } from '@/lib/auth-client';
import { AuthMode, useAuthForm } from '@/lib/hooks/use-auth-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouter, useSearchParams } from 'next/navigation';
import type { FormEvent } from 'react';

function EyeIcon({ off }: { off: boolean }) {
  return off ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19M6.61 6.61A18.5 18.5 0 0 0 2 12s3 8 10 8a9.12 9.12 0 0 0 5.39-1.61" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24M1 1l22 22" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function HeroForm() {
  const { state, actions } = useAuthForm();
  const [showPassword, setShowPassword] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get('from') || '/dashboard';
  const { isLoading, mode, email, password, name, error } = state;
  const isSignUp = mode === AuthMode.SignUp;

  const handleMicrosoftSignIn = async () => {
    actions.setLoading(true);
    const { error } = await signIn.social({ provider: 'microsoft', callbackURL: from });
    if (error?.message) actions.authError('Microsoft login mislykkedes. Prøv igen.');
    actions.setLoading(false);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    actions.authStart();

    if (!isSignUp) {
      const { error } = await signIn.email({ email, password, rememberMe: true });
      if (error) {
        actions.authError('Kunne ikke logge ind. Tjek venligst dine oplysninger.');
        return;
      }
    } else {
      const { error: signUpError } = await signUp.email({ name, email, password });
      if (signUpError) {
        actions.authError('Kunne ikke oprette konto. E-mailen er muligvis allerede i brug.');
        return;
      }
      const { error: signInError } = await signIn.email({ email, password, rememberMe: true });
      if (signInError) {
        actions.authError('Konto oprettet, men login mislykkedes. Prøv at logge ind.');
        return;
      }
    }
    router.push(from);
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ marginBottom: 4 }}>
        <h2 style={{ fontWeight: 500, fontSize: 19, letterSpacing: '-0.02em', color: 'var(--ink)', margin: '0 0 4px' }}>
          {isSignUp ? 'Opret din konto' : 'Velkommen tilbage'}
        </h2>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
          {isSignUp ? 'Gratis at komme i gang — intet kort påkrævet.' : 'Log ind for at fortsætte.'}
        </p>
      </div>
      <div style={{ visibility: isSignUp ? 'visible' : 'hidden' }}>
        <Label htmlFor="hero-name" style={{ display: 'block', fontSize: 12.5, fontWeight: 500, color: 'var(--ink-2)', marginBottom: 6 }}>Navn</Label>
        <Input
          id="hero-name"
          type="text"
          value={name}
          onChange={(e) => actions.setName(e.target.value)}
          placeholder="Jane Doe"
          required={isSignUp}
        />
      </div>
      <div>
        <Label htmlFor="hero-email" style={{ display: 'block', fontSize: 12.5, fontWeight: 500, color: 'var(--ink-2)', marginBottom: 6 }}>E-mail</Label>
        <Input
          id="hero-email"
          type="email"
          value={email}
          onChange={(e) => actions.setEmail(e.target.value)}
          placeholder="jane@example.com"
          required
        />
      </div>
      <div>
        <Label htmlFor="hero-password" style={{ display: 'block', fontSize: 12.5, fontWeight: 500, color: 'var(--ink-2)', marginBottom: 6 }}>Adgangskode</Label>
        <div style={{ position: 'relative' }}>
          <Input
            id="hero-password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => actions.setPassword(e.target.value)}
            placeholder="••••••••"
            required
            style={{ paddingRight: 40 }}
          />
          <button
            type="button"
            aria-label="Vis adgangskode"
            onClick={() => setShowPassword((v) => !v)}
            style={{
              position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
              width: 26, height: 26, border: 'none', background: 'transparent',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--muted)', cursor: 'pointer', borderRadius: 3,
              transition: 'color 120ms ease',
            }}
          >
            <EyeIcon off={showPassword} />
          </button>
        </div>
      </div>

      {error && (
        <div
          className="flex items-start gap-2.5 rounded-[var(--radius)] px-3 py-2.5"
          style={{
            background: 'var(--danger-wash)',
            border: '1px solid color-mix(in oklch, var(--danger) 22%, var(--line))',
          }}
        >
          <span className="font-mono text-[13px] leading-5" style={{ color: 'var(--danger)' }}>!</span>
          <span className="text-[13px] leading-snug" style={{ color: 'var(--danger)' }}>{error}</span>
        </div>
      )}

      <Button type="submit" disabled={isLoading} className="w-full" style={{ marginTop: 2 }}>
        {isLoading ? 'Behandler…' : isSignUp ? 'Opret konto' : 'Log ind'}
      </Button>

      {process.env.NEXT_PUBLIC_MICROSOFT_ENABLED === 'true' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '2px 0' }}>
            <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
            <span style={{ fontSize: 11.5, color: 'var(--muted)', fontFamily: 'var(--font-geist-mono)' }}>eller</span>
            <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
          </div>
          <Button type="button" variant="outline" onClick={handleMicrosoftSignIn} disabled={isLoading} className="w-full">
            <svg className="h-4 w-4" viewBox="0 0 23 23" fill="none">
              <path fill="#f25022" d="M1 1h10v10H1z" />
              <path fill="#00a4ef" d="M12 1h10v10H12z" />
              <path fill="#7fba00" d="M1 12h10v10H1z" />
              <path fill="#ffb900" d="M12 12h10v10H12z" />
            </svg>
            Fortsæt med Microsoft
          </Button>
        </>
      )}

      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '4px 0 0' }}>
        {isSignUp ? 'Har du allerede en konto? ' : 'Har du ikke en konto? '}
        <button
          type="button"
          onClick={() => actions.setMode(isSignUp ? AuthMode.SignIn : AuthMode.SignUp)}
          style={{
            color: 'var(--accent)',
            textDecoration: 'underline',
            textDecorationColor: 'color-mix(in oklch, var(--accent) 35%, #fff)',
            textUnderlineOffset: '2.5px',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            font: 'inherit',
            padding: 0,
            fontSize: 12.5,
            transition: 'color 120ms ease',
          }}
        >
          {isSignUp ? 'Log ind' : 'Opret konto'}
        </button>
      </p>
    </form>
  );
}
