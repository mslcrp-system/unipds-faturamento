"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useActiveTenant } from "@/lib/use-active-tenant";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Calendar } from "lucide-react";

type Fechamento = {
  fechamento_id: string;
  ano_mes: string;
  estado: "ABERTO" | "EM_REVISAO" | "FECHADO" | "REABERTO";
  faturamento_pipe_deals: number | null;
  faturamento_voomp_contratos: number | null;
  total_matches: number | null;
  total_orfaos_pipe: number | null;
  total_orfaos_voomp: number | null;
  hash_relatorio: string | null;
  fechado_em: string | null;
};

const estadoVariants: Record<Fechamento["estado"], "muted" | "warning" | "success" | "destructive"> = {
  ABERTO: "muted",
  EM_REVISAO: "warning",
  FECHADO: "success",
  REABERTO: "destructive",
};

export default function DashboardPage() {
  const tenantId = useActiveTenant();
  const supabase = createClient();
  const [list, setList] = useState<Fechamento[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [novoMes, setNovoMes] = useState("");

  useEffect(() => {
    if (!tenantId) return;
    setLoading(true);
    supabase
      .schema("conciliacao")
      .from("fechamentos_mensais")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("ano_mes", { ascending: false })
      .then(({ data }) => {
        setList((data ?? []) as Fechamento[]);
        setLoading(false);
      });
  }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function criarFechamento() {
    if (!novoMes || !tenantId) return;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(novoMes)) {
      alert("Formato inválido. Use YYYY-MM (ex: 2026-04).");
      return;
    }
    setCreating(true);
    const { error } = await supabase
      .schema("conciliacao")
      .from("fechamentos_mensais")
      .insert({ tenant_id: tenantId, ano_mes: novoMes, estado: "ABERTO" });
    setCreating(false);
    if (error) {
      alert(`Erro: ${error.message}`);
    } else {
      window.location.reload();
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Fechamentos mensais</h1>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="YYYY-MM"
            value={novoMes}
            onChange={(e) => setNovoMes(e.target.value)}
            className="h-9 px-3 rounded-md border border-border text-sm"
          />
          <Button onClick={criarFechamento} disabled={creating || !novoMes}>
            <Plus className="h-4 w-4 mr-1" /> Criar mês
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="text-muted-foreground">Carregando...</p>
      ) : list.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            <Calendar className="h-8 w-8 mx-auto mb-2 opacity-50" />
            Nenhum fechamento criado. Adicione um mês acima para começar.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {list.map((f) => (
            <Link key={f.fechamento_id} href={`/mes/${f.ano_mes}`}>
              <Card className="hover:bg-muted/30 transition-colors">
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="text-lg font-semibold">{f.ano_mes}</div>
                    <Badge variant={estadoVariants[f.estado]}>{f.estado}</Badge>
                  </div>
                  <div className="flex items-center gap-6 text-sm">
                    <div>
                      <span className="text-muted-foreground">Pipe:</span>{" "}
                      <span className="font-medium">{f.faturamento_pipe_deals ?? "-"}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Voomp:</span>{" "}
                      <span className="font-medium">{f.faturamento_voomp_contratos ?? "-"}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Matches:</span>{" "}
                      <span className="font-medium">{f.total_matches ?? "-"}</span>
                    </div>
                    {f.hash_relatorio && (
                      <span className="font-mono text-xs text-muted-foreground" title={f.hash_relatorio}>
                        {f.hash_relatorio.slice(0, 8)}…
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
