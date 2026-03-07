"use client";

import { useState, type FormEvent } from "react";
import { useAuth } from "@/context/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import "./page.css";

export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setLoading(false);
    }
  }

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__brand">
          <div className="login__logo">
            <span className="login__logo-letter">b</span>
          </div>
          <h1 className="login__title">buffr</h1>
          <p className="login__subtitle">
            Developer continuity &amp; momentum
          </p>
        </div>

        <form onSubmit={handleSubmit} className="login__form">
          <div className="login__fields">
            <Input
              label="Username"
              type="text"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setError(null);
              }}
              placeholder="Enter username"
              autoFocus
              mono
            />
            <Input
              label="Password"
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              placeholder="Enter password"
            />

            {error && <div className="login__error">{error}</div>}

            <Button
              type="submit"
              size="lg"
              loading={loading}
              disabled={!username.trim() || !password.trim()}
              className="login__submit"
            >
              {loading ? "Signing in\u2026" : "Sign in"}
            </Button>
          </div>
        </form>

        <p className="login__footnote">
          Single-user access &mdash; credentials set in environment variables
        </p>
      </div>
    </div>
  );
}
