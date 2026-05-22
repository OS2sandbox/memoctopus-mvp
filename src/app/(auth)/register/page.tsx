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

const schema = z
  .object({
    name: z.string().min(2, 'Navn skal have mindst 2 tegn').max(100),
    email: z.string().email('Ugyldig e-mailadresse'),
    password: z.string().min(8, 'Adgangskoden skal have mindst 8 tegn'),
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: 'Adgangskoderne er ikke ens',
    path: ['confirmPassword'],
  });

type FormData = z.infer<typeof schema>;

export default function RegisterPage() {
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
      const res = await fetch('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: data.name,
          email: data.email,
          password: data.password,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.message ?? d.error ?? 'Kunne ikke oprette konto');
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
          <p className="mt-1 text-sm text-[var(--text-muted)]">Opret en ny konto</p>
        </div>

        <div className="bg-[var(--surface)] rounded-[var(--radius-lg)] border border-[var(--border)] p-6">
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">Fulde navn</Label>
              <Input
                id="name"
                placeholder="Dit navn"
                autoComplete="name"
                aria-invalid={!!errors.name}
                {...register('name')}
              />
              {errors.name && (
                <p className="text-xs text-[var(--danger)]">{errors.name.message}</p>
              )}
            </div>

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
                autoComplete="new-password"
                aria-invalid={!!errors.password}
                {...register('password')}
              />
              {errors.password && (
                <p className="text-xs text-[var(--danger)]">{errors.password.message}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="confirmPassword">Gentag adgangskode</Label>
              <Input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                aria-invalid={!!errors.confirmPassword}
                {...register('confirmPassword')}
              />
              {errors.confirmPassword && (
                <p className="text-xs text-[var(--danger)]">{errors.confirmPassword.message}</p>
              )}
            </div>

            {serverError && (
              <div className="rounded-[var(--radius)] border border-red-200 bg-red-50 px-3 py-2 text-sm text-[var(--danger)]">
                {serverError}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? 'Opretter konto...' : 'Opret konto'}
            </Button>
          </form>
        </div>

        <p className="mt-4 text-center text-sm text-[var(--text-muted)]">
          Har du allerede en konto?{' '}
          <Link href="/login" className="text-[var(--accent)] hover:underline">
            Log ind
          </Link>
        </p>
      </div>
    </div>
  );
}
