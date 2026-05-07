"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { TENANTS, tenantById } from "@/lib/tenants";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";

export function Header() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState<string | null>(null);
  const [activeTenant, setActiveTenant] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null);
      const meta = (data.user?.user_metadata ?? {}) as { tenant_id?: string };
      const stored = typeof window !== "undefined" ? localStorage.getItem("active_tenant") : null;
      const initial = stored ?? meta.tenant_id ?? TENANTS[0].id;
      setActiveTenant(initial);
    });
  }, [supabase]);

  function changeTenant(tid: string) {
    localStorage.setItem("active_tenant", tid);
    setActiveTenant(tid);
    router.refresh();
    window.location.reload();
  }

  async function logout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  const t = tenantById(activeTenant);

  return (
    <header className="border-b border-border bg-white">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link href="/" className="font-semibold">Unipds Conciliação</Link>
          <select
            value={activeTenant ?? ""}
            onChange={(e) => changeTenant(e.target.value)}
            className="h-8 px-2 rounded-md border border-border text-sm"
          >
            {TENANTS.map((t) => (
              <option key={t.id} value={t.id}>{t.curto}</option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">{t?.nome}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{email}</span>
          <Button variant="ghost" size="sm" onClick={logout}>
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </header>
  );
}
