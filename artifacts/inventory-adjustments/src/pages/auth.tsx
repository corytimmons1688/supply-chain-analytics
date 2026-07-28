import * as React from "react";
import { Link, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

/**
 * Auth pages backed by the shared Better Auth server (via this app's proxy).
 * All flows go through the official SDK — no hand-rolled auth calls.
 */

const MIN_PASSWORD_CHARS = 8;
const DEFAULT_LOCKOUT_SECONDS = 5 * 60;

function appUrl(path: string): string {
  return `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}${path}`;
}

function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="text-xs uppercase tracking-widest text-muted-foreground">Calyx Containers · Supply Chain</div>
          <CardTitle className="text-lg">{title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">{children}</CardContent>
      </Card>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-medium text-muted-foreground mb-1">{children}</div>;
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-red-600 dark:text-red-400">{children}</div>;
}

// ---------------------------------------------------------------------------

export function LoginPage() {
  const [, navigate] = useLocation();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<React.ReactNode>(null);
  const [busy, setBusy] = React.useState(false);
  const [unverified, setUnverified] = React.useState(false);
  const [resent, setResent] = React.useState(false);
  // 429 lockout countdown — submit stays disabled until it expires.
  const [lockedUntil, setLockedUntil] = React.useState<number | null>(null);
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    if (!lockedUntil) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [lockedUntil]);
  const lockSecondsLeft = lockedUntil ? Math.max(0, Math.ceil((lockedUntil - now) / 1000)) : 0;
  React.useEffect(() => {
    if (lockedUntil && lockSecondsLeft === 0) setLockedUntil(null);
  }, [lockedUntil, lockSecondsLeft]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setUnverified(false);
    setBusy(true);
    try {
      const { error: err } = await authClient.signIn.email({ email, password });
      if (!err) {
        // Full reload so every query starts fresh with the new token.
        window.location.assign(appUrl("/"));
        return;
      }
      if (err.status === 401) {
        // Generic on purpose — never reveal which field was wrong.
        setError("Invalid email or password.");
      } else if (err.status === 403) {
        setUnverified(true);
        setError("Your email address hasn't been verified yet.");
      } else if (err.status === 429) {
        // The body may carry retryAfter seconds or a "try again in N minutes"
        // message; fall back to a 5-minute lockout.
        const explicit = (err as { retryAfter?: number }).retryAfter;
        const msg = err.message ?? "";
        const secMatch = /(\d+)\s*sec/i.exec(msg);
        const minMatch = /(\d+)\s*min/i.exec(msg);
        const retryAfter =
          typeof explicit === "number" && explicit > 0
            ? explicit
            : secMatch
              ? Number(secMatch[1])
              : minMatch
                ? Number(minMatch[1]) * 60
                : DEFAULT_LOCKOUT_SECONDS;
        setLockedUntil(Date.now() + retryAfter * 1000);
        setError("Too many failed attempts — this account is temporarily locked.");
      } else {
        setError(err.message || "Sign-in failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Sign in">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <FieldLabel>Email</FieldLabel>
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </div>
        <div>
          <FieldLabel>Password</FieldLabel>
          <Input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        {lockedUntil && lockSecondsLeft > 0 && (
          <div className="text-xs text-amber-700 dark:text-amber-400 tabular-nums">
            Try again in {Math.floor(lockSecondsLeft / 60)}:{String(lockSecondsLeft % 60).padStart(2, "0")}
          </div>
        )}
        {unverified && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            disabled={resent}
            onClick={async () => {
              await authClient.sendVerificationEmail({ email, callbackURL: appUrl("/verify-email") }).catch(() => {});
              setResent(true);
            }}
          >
            {resent ? "Verification email sent" : "Resend verification email"}
          </Button>
        )}
        <Button type="submit" className="w-full" disabled={busy || (lockedUntil != null && lockSecondsLeft > 0)}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <div className="flex justify-between text-xs">
        <button type="button" className="text-primary hover:underline" onClick={() => navigate("/forgot-password")}>
          Forgot password?
        </button>
        <Link href="/register" className="text-primary hover:underline">
          Create an account
        </Link>
      </div>
    </AuthShell>
  );
}

// ---------------------------------------------------------------------------

export function RegisterPage() {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_CHARS) {
      setError(`Password must be at least ${MIN_PASSWORD_CHARS} characters.`);
      return;
    }
    setBusy(true);
    try {
      const { error: err } = await authClient.signUp.email({ name, email, password });
      if (err) setError(err.message || "Registration failed.");
      else setDone(true);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <AuthShell title="Check your email">
        <p className="text-sm text-muted-foreground">
          We sent a verification link to <span className="font-medium text-foreground">{email}</span>. Follow it to
          verify your address, then sign in.
        </p>
        <Link href="/login" className="text-primary text-sm hover:underline">
          Back to sign in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Create an account">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <FieldLabel>Name</FieldLabel>
          <Input required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </div>
        <div>
          <FieldLabel>Email</FieldLabel>
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </div>
        <div>
          <FieldLabel>Password</FieldLabel>
          <Input
            type="password"
            required
            minLength={MIN_PASSWORD_CHARS}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
          <div className="text-[10px] text-muted-foreground mt-0.5">At least {MIN_PASSWORD_CHARS} characters.</div>
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Creating…" : "Create account"}
        </Button>
      </form>
      <Link href="/login" className="text-primary text-xs hover:underline">
        Already have an account? Sign in
      </Link>
    </AuthShell>
  );
}

// ---------------------------------------------------------------------------

export function VerifyEmailPage() {
  const token = new URLSearchParams(window.location.search).get("token");
  const [state, setState] = React.useState<"working" | "ok" | "failed">(token ? "working" : "failed");
  const [email, setEmail] = React.useState("");
  const [resent, setResent] = React.useState(false);

  React.useEffect(() => {
    if (!token) return;
    authClient
      .verifyEmail({ query: { token } })
      .then(({ error }) => setState(error ? "failed" : "ok"))
      .catch(() => setState("failed"));
  }, [token]);

  return (
    <AuthShell title="Email verification">
      {state === "working" && <p className="text-sm text-muted-foreground">Verifying…</p>}
      {state === "ok" && (
        <>
          <p className="text-sm">Your email is verified. You can sign in now.</p>
          <Link href="/login" className="text-primary text-sm hover:underline">
            Go to sign in
          </Link>
        </>
      )}
      {state === "failed" && (
        <>
          <p className="text-sm text-muted-foreground">
            {token ? "This verification link is invalid or has expired." : "No verification token in the link."} Enter
            your email to receive a new one:
          </p>
          <Input type="email" placeholder="you@calyxcontainers.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button
            className="w-full"
            size="sm"
            disabled={!email || resent}
            onClick={async () => {
              await authClient.sendVerificationEmail({ email, callbackURL: appUrl("/verify-email") }).catch(() => {});
              setResent(true);
            }}
          >
            {resent ? "Sent — check your email" : "Resend verification email"}
          </Button>
        </>
      )}
    </AuthShell>
  );
}

// ---------------------------------------------------------------------------

export function ForgotPasswordPage() {
  const [email, setEmail] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await authClient.requestPasswordReset({ email, redirectTo: appUrl("/reset-password") }).catch(() => {});
    } finally {
      // Always neutral — never reveal whether the account exists.
      setDone(true);
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Reset your password">
      {done ? (
        <p className="text-sm text-muted-foreground">
          If an account exists for that address, a password reset email is on its way.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <div>
            <FieldLabel>Email</FieldLabel>
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      )}
      <Link href="/login" className="text-primary text-xs hover:underline">
        Back to sign in
      </Link>
    </AuthShell>
  );
}

// ---------------------------------------------------------------------------

export function ResetPasswordPage() {
  const [, navigate] = useLocation();
  const token = new URLSearchParams(window.location.search).get("token");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!token) {
      setError("This reset link is missing its token — request a new one.");
      return;
    }
    if (password.length < MIN_PASSWORD_CHARS) {
      setError(`Password must be at least ${MIN_PASSWORD_CHARS} characters.`);
      return;
    }
    setBusy(true);
    try {
      const { error: err } = await authClient.resetPassword({ newPassword: password, token });
      if (err) setError(err.message || "Could not reset the password — the link may have expired.");
      else navigate("/login");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Choose a new password">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <FieldLabel>New password</FieldLabel>
          <Input
            type="password"
            required
            minLength={MIN_PASSWORD_CHARS}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Saving…" : "Set new password"}
        </Button>
      </form>
      <Link href="/forgot-password" className="text-primary text-xs hover:underline">
        Request a new reset link
      </Link>
    </AuthShell>
  );
}
