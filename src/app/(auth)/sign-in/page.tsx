'use client';

import { signIn, signUp } from '@/lib/auth-client';
import { AuthMode, useAuthForm } from '@/lib/hooks/use-auth-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRouter } from 'next/navigation';
import { type FormEvent } from 'react';

export default function SignInPage() {
  const { state, actions } = useAuthForm();
  const router = useRouter();
  const { isLoading, mode, email, password, name, error } = state;

  const handleEmailAuth = async (e: FormEvent) => {
    e.preventDefault();
    actions.authStart();

    if (mode === AuthMode.SignIn) {
      const { error } = await signIn.email({ email, password, rememberMe: true });
      if (error) {
        actions.authError('Kunne ikke logge ind. Tjek venligst dine oplysninger.');
        return;
      }
      router.push('/');
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
      router.push('/');
    }
    actions.setLoading(false);
  };

  const handleMicrosoftSignIn = async () => {
    actions.setLoading(true);
    const { error } = await signIn.social({ provider: 'microsoft', callbackURL: '/' });
    if (error?.message) actions.authError('Microsoft login mislykkedes. Prøv igen.');
    actions.setLoading(false);
  };

  return (
    <div className="w-full max-w-sm space-y-8">
      <div className="text-center">
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontWeight: 500,
            fontSize: 16,
            letterSpacing: '-0.03em',
            color: 'var(--ink)',
            marginBottom: 8,
          }}
        >
          memoctopus<span style={{ color: 'var(--accent)', padding: '0 5px' }}>·</span>referat
        </div>
        <p style={{ fontSize: 13.5, color: 'var(--ink-2)' }}>
          {mode === AuthMode.SignIn ? 'Log ind på din konto' : 'Opret din konto'}
        </p>
      </div>

      <form onSubmit={handleEmailAuth} className="space-y-4">
        {mode === AuthMode.SignUp && (
          <div className="space-y-1.5">
            <Label htmlFor="name">Navn</Label>
            <Input
              id="name"
              type="text"
              value={name}
              onChange={(e) => actions.setName(e.target.value)}
              placeholder="Jane Doe"
              required
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="email">E-mail</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => actions.setEmail(e.target.value)}
            placeholder="jane@example.com"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Adgangskode</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => actions.setPassword(e.target.value)}
            placeholder="••••••••"
            required
          />
        </div>

        {error && (
          <p style={{ fontSize: 13, color: 'var(--keep)' }}>{error}</p>
        )}

        <Button type="submit" disabled={isLoading} className="w-full">
          {isLoading
            ? 'Behandler...'
            : mode === AuthMode.SignUp
              ? 'Opret konto'
              : 'Log ind'}
        </Button>

        <p style={{ textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
          {mode === AuthMode.SignIn ? (
            <>
              Har du ikke en konto?{' '}
              <button
                type="button"
                onClick={() => actions.setMode(AuthMode.SignUp)}
                style={{ color: 'var(--ink-2)', textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', font: 'inherit' }}
              >
                Opret konto
              </button>
            </>
          ) : (
            <>
              Har du allerede en konto?{' '}
              <button
                type="button"
                onClick={() => actions.setMode(AuthMode.SignIn)}
                style={{ color: 'var(--ink-2)', textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', font: 'inherit' }}
              >
                Log ind
              </button>
            </>
          )}
        </p>
      </form>

      {process.env.NEXT_PUBLIC_MICROSOFT_ENABLED === 'true' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
            <span style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>eller</span>
            <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
          </div>

          <Button
            type="button"
            variant="outline"
            onClick={handleMicrosoftSignIn}
            disabled={isLoading}
            className="w-full"
          >
            <svg className="h-4 w-4" viewBox="0 0 23 23" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path fill="#f25022" d="M1 1h10v10H1z" />
              <path fill="#00a4ef" d="M12 1h10v10H12z" />
              <path fill="#7fba00" d="M1 12h10v10H1z" />
              <path fill="#ffb900" d="M12 12h10v10H12z" />
            </svg>
            Microsoft
          </Button>
        </>
      )}
    </div>
  );
}
