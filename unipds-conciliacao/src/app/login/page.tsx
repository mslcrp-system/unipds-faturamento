"use client";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      setStatus("error");
      setError(error.message);
    } else {
      setStatus("sent");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">Unipds — Conciliação</CardTitle>
          <p className="text-sm text-muted-foreground">Entre com seu email para receber o link de acesso.</p>
        </CardHeader>
        <CardContent>
          {status === "sent" ? (
            <div className="text-sm">
              <p className="font-medium text-success mb-2">Link enviado.</p>
              <p className="text-muted-foreground">Verifique sua caixa de entrada em <span className="font-mono">{email}</span>.</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1.5" htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full h-9 px-3 rounded-md border border-border focus:ring-2 focus:outline-none"
                  placeholder="seu@email.com"
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={status === "sending"} className="w-full">
                {status === "sending" ? "Enviando..." : "Receber link de acesso"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
