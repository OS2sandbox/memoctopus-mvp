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

import { type FormEvent, Fragment } from "react";

export default function SignInPage() {
  const { state, actions } = useAuthForm();

  const { isLoading, mode, email, password, name, error } = state;

  const handleEmailAuth = async (e: FormEvent) => {
    e.preventDefault();
    actions.authStart();

    switch (mode) {
      case AUTH_MODE.SignIn: {
        const { error } = await signIn.email({
          email,
          password,
          rememberMe: true,
          callbackURL: "/app",
        });
        if (error) {
          actions.authError("Authentication failed. Please check your input.");
        }
        actions.setLoading(false);
        break;
      }
      case AUTH_MODE.SignUp: {
        const { error: signUpError } = await signUp.email({
          name,
          email,
          password,
        });

        const { error: signInError } = await signIn.email({
          email,
          password,
          rememberMe: true,
          callbackURL: "/app",
        });

        if (signUpError || signInError) {
          actions.authError("Authentication failed. Please check your input.");
        }
        actions.setLoading(false);
        break;
      }
    }
  };

  const handleSocialSignIn = async () => {
    actions.setLoading(true);
    const { error } = await signIn.social({
      provider: "microsoft",
      callbackURL: "/app",
    });
    if (error?.message)
      actions.authError("Social sign-in failed. Please try again.");
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
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => actions.setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                  />
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
                      Don’t have an account?{" "}
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
