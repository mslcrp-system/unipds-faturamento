"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useActiveTenant } from "@/lib/use-active-tenant";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Link2 } from "lucide-react";

type OrfaoPipe = {
  pipe_deal_id:  number;
  pessoa_nome:   string | null;
  pipe_cpf:      string | null;
  pipe_valor:    number;
  voomp_data_pagamento: string | null;
};

type OrfaoVoomp = {
  snapshot_id:         string;
  voomp_aluno_nome:    string | null;
  voomp_cpf:           string | null;
  voomp_valor_cobrado: number;
  voomp_data_pagamento:string | null;
  produto_nome:        string | null;
};

export default function ConciliacaoPage() {
  const { ano_mes } = useParams<{ ano_mes: string }>();
  const tenantId = useActiveTenant();
  const supabase = createClient();
  const [pipe, setPipe] = useState<OrfaoPipe[]>([]);
  const [voomp, setVoomp] = useState<OrfaoVoomp[]>([]);
  const [selPipe, setSelPipe] = useState<number | null>(null);
  const [selVoomp, setSelVoomp] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState(false);

  async function load() {
    if (!tenantId) return;
    setLoading(true);
    const { data } = await supabase
      .schema("conciliacao")
      .from("v_cruzamento")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("ano_mes", ano_mes)
      .in("status_match", ["ORFAO_PIPE", "ORFAO_VOOMP"]);

    const all = (data ?? []) as any[];
    setPipe(all.filter((r) => r.status_match === "ORFAO_PIPE") as OrfaoPipe[]);
    setVoomp(all.filter((r) => r.status_match === "ORFAO_VOOMP") as OrfaoVoomp[]);
    setLoading(false);
  }

  useEffect(() => { load(); }, [tenantId, ano_mes]); // eslint-disable-line react-hooks/exhaustive-deps

  async function vincular() {
    if (!selPipe || !selVoomp || !tenantId) return;
    if (!confirm(`Vincular deal Pipe ${selPipe} ao snapshot Voomp ${selVoomp}?`)) return;
    setLinking(true);

    const dealPipe = pipe.find((p) => p.pipe_deal_id === selPipe)!;
    const contratoVoomp = voomp.find((v) => v.snapshot_id === selVoomp)!;
    const div = dealPipe.pipe_valor - Number(contratoVoomp.voomp_valor_cobrado);
    const divPct = dealPipe.pipe_valor !== 0 ? Math.abs(div) / dealPipe.pipe_valor : 1;
    const classe =
      div === 0 ? "IDENTICO"
      : Math.abs(div) < 1 ? "CENTAVOS"
      : divPct >= 0.05 && divPct <= 0.20 ? "CUPOM_PROVAVEL"
      : "MATERIAL";

    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.schema("conciliacao").from("conciliacao_links").insert({
      tenant_id:         tenantId,
      ano_mes,
      pipe_deal_id:      selPipe,
      snapshot_id:       selVoomp,
      criterio:          "MANUAL",
      confianca:         100,
      divergencia_valor: Number(div.toFixed(2)),
      divergencia_classe: classe,
      created_by:        user?.id ?? null,
    });

    setLinking(false);
    if (error) alert(error.message);
    else { setSelPipe(null); setSelVoomp(null); load(); }
  }

  return (
    <div className="space-y-6">
      <Link href={`/mes/${ano_mes}`} className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4 mr-1" /> Voltar para {ano_mes}
      </Link>

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Conciliação manual — {ano_mes}</h1>
        <Button onClick={vincular} disabled={!selPipe || !selVoomp || linking}>
          <Link2 className="h-4 w-4 mr-2" />{linking ? "Vinculando..." : "Vincular selecionados"}
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        Selecione um órfão de cada lado e clique em Vincular. O vínculo é registrado como MANUAL com confiança 100%.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Órfãos Pipe ({pipe.length})</CardTitle>
            <p className="text-xs text-muted-foreground">Deals sem contrato Voomp correspondente</p>
          </CardHeader>
          <CardContent>
            {loading ? <p>Carregando...</p> : (
              <div className="space-y-1.5 max-h-[600px] overflow-y-auto">
                {pipe.map((p) => (
                  <button
                    key={p.pipe_deal_id}
                    onClick={() => setSelPipe(p.pipe_deal_id)}
                    className={`w-full text-left p-3 rounded-md border text-sm transition-colors ${selPipe === p.pipe_deal_id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/30"}`}
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{p.pessoa_nome ?? "—"}</div>
                        <div className="text-xs text-muted-foreground">{p.pipe_cpf ?? "sem CPF"}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono tabular-nums">R$ {Number(p.pipe_valor).toFixed(2)}</div>
                        <div className="text-xs text-muted-foreground">deal #{p.pipe_deal_id}</div>
                      </div>
                    </div>
                  </button>
                ))}
                {pipe.length === 0 && <p className="text-muted-foreground text-center py-8">Nenhum órfão Pipe.</p>}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Órfãos Voomp ({voomp.length})</CardTitle>
            <p className="text-xs text-muted-foreground">Contratos confirmados sem deal Pipe correspondente</p>
          </CardHeader>
          <CardContent>
            {loading ? <p>Carregando...</p> : (
              <div className="space-y-1.5 max-h-[600px] overflow-y-auto">
                {voomp.map((v) => (
                  <button
                    key={v.snapshot_id}
                    onClick={() => setSelVoomp(v.snapshot_id)}
                    className={`w-full text-left p-3 rounded-md border text-sm transition-colors ${selVoomp === v.snapshot_id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/30"}`}
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{v.voomp_aluno_nome ?? "—"}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {v.voomp_cpf ?? "sem CPF"} · {v.produto_nome ?? "—"}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono tabular-nums">R$ {Number(v.voomp_valor_cobrado).toFixed(2)}</div>
                        <div className="text-xs text-muted-foreground">pago {v.voomp_data_pagamento?.slice(0, 10)}</div>
                      </div>
                    </div>
                  </button>
                ))}
                {voomp.length === 0 && <p className="text-muted-foreground text-center py-8">Nenhum órfão Voomp.</p>}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
