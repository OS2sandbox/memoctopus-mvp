"use client";

import { Button } from "@/components/ui/core/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@/components/ui/core/field";
import { Input } from "@/components/ui/core/input";
import { authClient } from "@/lib/auth-client";

import { type FormEvent, useState } from "react";

enum Mode {
  SignUp,
  SignIn,
}

export default function SignInPage() {
  const [isLoading, setIsLoading] = useState(false);
  const [mode, setMode] = useState<Mode>(Mode.SignIn);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleEmailAuth = async (e: FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      switch (mode) {
        case Mode.SignIn: {
          await authClient.signIn.email({
            email,
            password,
            rememberMe: true,
            callbackURL: "/app",
          });
          break;
        }
        case Mode.SignUp: {
          await authClient.signUp.email({
            name,
            email,
            password,
            callbackURL: "/app",
          });
          break;
        }
      }
    } catch (err) {
      console.error(err);
      setError("Authentication failed. Please check your input.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSocialSignIn = async () => {
    setIsLoading(true);
    const { error } = await authClient.signIn.social({
      provider: "microsoft",
      callbackURL: "/app",
    });
    if (error?.message) setError(error.message);
    setIsLoading(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">
            Welcome to MemOctopus
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {mode === Mode.SignIn
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
                {mode === Mode.SignUp
                  ? "Fill in your details to register."
                  : "Enter your credentials to sign in."}
              </FieldDescription>

              <FieldGroup>
                {mode === Mode.SignUp && (
                  <Field>
                    <FieldLabel htmlFor="name">Full Name</FieldLabel>
                    <Input
                      id="name"
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
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
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
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
                      : mode === Mode.SignUp
                        ? "Sign Up"
                        : "Sign In"}
                  </Button>
                </Field>

                <p className="text-center text-xs text-muted-foreground mt-3">
                  {mode === Mode.SignIn ? (
                    <>
                      Don’t have an account?{" "}
                      <button
                        type="button"
                        onClick={() => setMode(Mode.SignUp)}
                        className="underline"
                      >
                        Sign up
                      </button>
                    </>
                  ) : (
                    <>
                      Already have an account?{" "}
                      <button
                        type="button"
                        onClick={() => setMode(Mode.SignIn)}
                        className="underline"
                      >
                        Sign in
                      </button>
                    </>
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

        <p className="text-center text-xs text-muted-foreground">
          By continuing, you agree to our Terms of Service and Privacy Policy.
        </p>
      </div>
    </div>
  );
}
