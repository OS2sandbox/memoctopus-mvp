'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const schema = z.object({
  email: z.string().email('Ugyldig e-mailadresse'),
  password: z.string().min(1, 'Adgangskode er påkrævet'),
});

type FormData = z.infer<typeof schema>;

export default function LoginPage() {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  async function onSubmit(data: FormData) {
    setIsSubmitting(true);
    setServerError(null);
    try {
      const res = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: data.email, password: data.password }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.message ?? d.error ?? 'Forkert e-mail eller adgangskode');
      }
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Noget gik galt');
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg)] px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-[var(--text)]">Referat</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Log ind på din konto</p>
        </div>

        <div className="bg-[var(--surface)] rounded-[var(--radius-lg)] border border-[var(--border)] p-6">
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">E-mail</Label>
              <Input
                id="email"
                type="email"
                placeholder="din@email.dk"
                autoComplete="email"
                aria-invalid={!!errors.email}
                {...register('email')}
              />
              {errors.email && (
                <p className="text-xs text-[var(--danger)]">{errors.email.message}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">Adgangskode</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                aria-invalid={!!errors.password}
                {...register('password')}
              />
              {errors.password && (
                <p className="text-xs text-[var(--danger)]">{errors.password.message}</p>
              )}
            </div>

            {serverError && (
              <div className="rounded-[var(--radius)] border border-red-200 bg-red-50 px-3 py-2 text-sm text-[var(--danger)]">
                {serverError}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? 'Logger ind...' : 'Log ind'}
            </Button>
          </form>
        </div>

        <p className="mt-4 text-center text-sm text-[var(--text-muted)]">
          Har du ikke en konto?{' '}
          <Link href="/register" className="text-[var(--accent)] hover:underline">
            Opret konto
          </Link>
        </p>
      </div>
    </div>
  );
}
