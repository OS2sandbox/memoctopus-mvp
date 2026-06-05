"use client";

import { signIn, signUp } from "@/lib/auth-client";
import { AUTH_MODE } from "@/lib/constants";
import { useAuthForm } from "@/lib/hooks/use-auth-form";
import { Button } from "@/lib/ui/core/shadcn/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@/lib/ui/core/shadcn/field";
import { Input } from "@/lib/ui/core/shadcn/input";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Fragment, Suspense, useState } from "react";

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

function SignInForm() {
  const { state, actions } = useAuthForm();
  const [showPassword, setShowPassword] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get("from") || "/app";

  const { isLoading, mode, email, password, name, error } = state;

  const handleEmailAuth = async (e: FormEvent) => {
    e.preventDefault();
    actions.authStart();

    switch (mode) {
      case AUTH_MODE.SignIn: {
        const { error } = await signIn.email({ email, password, rememberMe: true });
        if (error) {
          actions.authError("Kunne ikke logge ind. Tjek venligst dine oplysninger.");
          return;
        }
        router.push(from);
        break;
      }
      case AUTH_MODE.SignUp: {
        const { error: signUpError } = await signUp.email({ name, email, password });
        if (signUpError) {
          actions.authError("Kunne ikke oprette konto. E-mailen er muligvis allerede i brug.");
          return;
        }
        const { error: signInError } = await signIn.email({ email, password, rememberMe: true });
        if (signInError) {
          actions.authError("Konto oprettet, men login mislykkedes. Prøv at logge ind.");
          return;
        }
        router.push(from);
        break;
      }
    }
    actions.setLoading(false);
  };

  const handleSocialSignIn = async () => {
    actions.setLoading(true);
    const { error } = await signIn.social({ provider: "microsoft", callbackURL: from });
    if (error?.message) actions.authError("Microsoft login mislykkedes. Prøv igen.");
    actions.setLoading(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">
            Welcome to MemOctopus
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {mode === AUTH_MODE.SignIn
              ? "Sign in to your account"
              : "Create your account"}
          </p>
        </div>

        <form
          onSubmit={handleEmailAuth}
          className="rounded-lg border border-border bg-card p-8 shadow-sm"
        >
          <FieldGroup>
            <FieldSet>
              <FieldLegend>Email Authentication</FieldLegend>
              <FieldDescription>
                {mode === AUTH_MODE.SignUp
                  ? "Fill in your details to register."
                  : "Enter your credentials to sign in."}
              </FieldDescription>

              <FieldGroup>
                {mode === AUTH_MODE.SignUp && (
                  <Field>
                    <FieldLabel htmlFor="name">Full Name</FieldLabel>
                    <Input
                      id="name"
                      type="text"
                      value={name}
                      onChange={(e) => actions.setName(e.target.value)}
                      placeholder="Jane Doe"
                      required
                    />
                  </Field>
                )}
                <Field>
                  <FieldLabel htmlFor="email">Email</FieldLabel>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => actions.setEmail(e.target.value)}
                    placeholder="janedoe@domain.com"
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => actions.setPassword(e.target.value)}
                      placeholder="••••••••"
                      required
                      className="pr-10"
                    />
                    <button
                      type="button"
                      aria-label="Toggle password visibility"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <EyeIcon off={showPassword} />
                    </button>
                  </div>
                  <FieldDescription>
                    Minimum 8 characters recommended.
                  </FieldDescription>
                </Field>

                {error && <p className="text-sm text-red-500 mt-2">{error}</p>}

                <Field orientation="horizontal">
                  <Button type="submit" disabled={isLoading} className="w-full">
                    {isLoading
                      ? "Processing..."
                      : mode === AUTH_MODE.SignUp
                        ? "Sign Up"
                        : "Sign In"}
                  </Button>
                </Field>

                <p className="text-center text-xs text-muted-foreground mt-3">
                  {mode === AUTH_MODE.SignIn ? (
                    <Fragment>
                      Don't have an account?{" "}
                      <button
                        type="button"
                        onClick={() => actions.setMode(AUTH_MODE.SignUp)}
                        className="underline"
                      >
                        Sign up
                      </button>
                    </Fragment>
                  ) : (
                    <Fragment>
                      Already have an account?{" "}
                      <button
                        type="button"
                        onClick={() => actions.setMode(AUTH_MODE.SignIn)}
                        className="underline"
                      >
                        Sign in
                      </button>
                    </Fragment>
                  )}
                </p>
              </FieldGroup>
            </FieldSet>

            <FieldSeparator />

            <FieldSet>
              <FieldLegend>Or continue with</FieldLegend>
              <FieldGroup>
                <Button
                  type="button"
                  onClick={handleSocialSignIn}
                  variant="outline"
                  disabled={isLoading}
                  className="w-full flex items-center justify-center gap-2"
                >
                  <svg
                    className="h-5 w-5"
                    viewBox="0 0 23 23"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path fill="#f25022" d="M1 1h10v10H1z" />
                    <path fill="#00a4ef" d="M12 1h10v10H12z" />
                    <path fill="#7fba00" d="M1 12h10v10H1z" />
                    <path fill="#ffb900" d="M12 12h10v10H12z" />
                  </svg>
                  Microsoft
                </Button>
              </FieldGroup>
            </FieldSet>
          </FieldGroup>
        </form>
      </div>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
