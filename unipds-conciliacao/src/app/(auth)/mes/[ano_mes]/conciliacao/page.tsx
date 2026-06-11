"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useActiveTenant } from "@/lib/use-active-tenant";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Link2, Search, X } from "lucide-react";
import {
  classificarDivergencia, mesLabel, fmtBRL, scoreCandidato,
  CLASSE_LABEL, CLASSE_VARIANT,
} from "@/lib/conciliacao-ui";

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
  voomp_venda_id:      string | null;
  voomp_contrato_id:   string | null;
  qtd_cobrancas:       number | null;
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
  const [fechado, setFechado] = useState(false);
  const [busca, setBusca] = useState("");

  const q = busca.trim().toLowerCase();

  const pipeSel  = pipe.find((p) => p.pipe_deal_id === selPipe) ?? null;
  const voompSel = voomp.find((v) => v.snapshot_id === selVoomp) ?? null;

  // Lista Pipe: filtra pela busca; se houver Voomp selecionado, ordena por
  // probabilidade de ser o par (nome + valor). Senão, ordem alfabética.
  const pipeFiltrado = useMemo(() => {
    let base = q
      ? pipe.filter((p) =>
          (p.pessoa_nome ?? "").toLowerCase().includes(q) ||
          (p.pipe_cpf ?? "").includes(q) ||
          String(p.pipe_deal_id).includes(q))
      : pipe;
    if (voompSel) {
      return base
        .map((p) => ({ ...p, _score: scoreCandidato(voompSel.voomp_aluno_nome, Number(voompSel.voomp_valor_cobrado), p.pessoa_nome, Number(p.pipe_valor)) }))
        .sort((a, b) => b._score - a._score);
    }
    return [...base]
      .map((p) => ({ ...p, _score: 0 }))
      .sort((a, b) => (a.pessoa_nome ?? "").localeCompare(b.pessoa_nome ?? ""));
  }, [pipe, q, voompSel]);

  // Lista Voomp: idem, ranqueada quando há deal Pipe selecionado.
  const voompFiltrado = useMemo(() => {
    let base = q
      ? voomp.filter((v) =>
          (v.voomp_aluno_nome ?? "").toLowerCase().includes(q) ||
          (v.voomp_cpf ?? "").includes(q) ||
          (v.voomp_venda_id ?? "").includes(q) ||
          (v.produto_nome ?? "").toLowerCase().includes(q))
      : voomp;
    if (pipeSel) {
      return base
        .map((v) => ({ ...v, _score: scoreCandidato(pipeSel.pessoa_nome, Number(pipeSel.pipe_valor), v.voomp_aluno_nome, Number(v.voomp_valor_cobrado)) }))
        .sort((a, b) => b._score - a._score);
    }
    return [...base]
      .map((v) => ({ ...v, _score: 0 }))
      .sort((a, b) => (a.voomp_aluno_nome ?? "").localeCompare(b.voomp_aluno_nome ?? ""));
  }, [voomp, q, pipeSel]);

  const classePrevista = pipeSel && voompSel
    ? classificarDivergencia(pipeSel.pipe_valor, Number(voompSel.voomp_valor_cobrado))
    : null;

  async function load() {
    if (!tenantId) return;
    setLoading(true);
    const [{ data }, { data: f }] = await Promise.all([
      supabase
        .schema("conciliacao")
        .from("v_cruzamento")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("ano_mes", ano_mes)
        .in("status_match", ["ORFAO_PIPE", "ORFAO_VOOMP"]),
      supabase
        .schema("conciliacao")
        .from("fechamentos_mensais")
        .select("estado")
        .eq("tenant_id", tenantId)
        .eq("ano_mes", ano_mes)
        .maybeSingle(),
    ]);

    const all = (data ?? []) as any[];
    setPipe(all.filter((r) => r.status_match === "ORFAO_PIPE") as OrfaoPipe[]);
    setVoomp(all.filter((r) => r.status_match === "ORFAO_VOOMP") as OrfaoVoomp[]);
    setFechado(f?.estado === "FECHADO");
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
    const classe = classificarDivergencia(dealPipe.pipe_valor, Number(contratoVoomp.voomp_valor_cobrado));

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
    if (error) {
      alert(error.message.includes("FECHADO")
        ? "Este mês está FECHADO — vínculos bloqueados. A reabertura é feita pelo gestor do banco."
        : error.message);
    } else { setSelPipe(null); setSelVoomp(null); load(); }
  }

  return (
    <div className="space-y-6">
      <Link href={`/mes/${ano_mes}`} className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4 mr-1" /> Voltar para {mesLabel(ano_mes)}
      </Link>

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Vincular manualmente — {mesLabel(ano_mes)}</h1>
        <Button onClick={vincular} disabled={!selPipe || !selVoomp || linking || fechado}>
          <Link2 className="h-4 w-4 mr-2" />{linking ? "Vinculando..." : "Vincular selecionados"}
        </Button>
      </div>

      {fechado && (
        <p className="text-sm text-muted-foreground">
          Mês FECHADO — somente leitura. Vínculos manuais estão bloqueados.
        </p>
      )}

      <p className="text-sm text-muted-foreground">
        Selecione uma venda de um dos lados — a outra lista se reordena automaticamente
        colocando os pares mais prováveis no topo (nome e valor parecidos). Confira a
        comparação e clique em Vincular.
      </p>

      <div className="relative max-w-sm">
        <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          placeholder="Buscar nome, CPF ou venda nas duas listas..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          className="h-9 pl-8 pr-3 rounded-md border border-border text-sm w-full"
        />
      </div>

      {/* ── Barra de comparação (fixa ao rolar) ───────────────────── */}
      {(pipeSel || voompSel) && (
        <div className="sticky top-2 z-10">
          <Card className="border-primary/40 bg-background shadow-md">
            <CardContent className="p-3">
              <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-4 text-sm">
                <div className="flex-1 min-w-0">
                  <span className="text-xs text-muted-foreground uppercase">Pipe</span>
                  <div className="truncate font-medium">
                    {pipeSel ? `${pipeSel.pessoa_nome ?? "—"} · ${fmtBRL(Number(pipeSel.pipe_valor))}` : "selecione à esquerda…"}
                  </div>
                </div>
                <span className="text-muted-foreground shrink-0">⇄</span>
                <div className="flex-1 min-w-0">
                  <span className="text-xs text-muted-foreground uppercase">Voomp</span>
                  <div className="truncate font-medium">
                    {voompSel ? `${voompSel.voomp_aluno_nome ?? "—"} · ${fmtBRL(Number(voompSel.voomp_valor_cobrado))}` : "selecione à direita…"}
                  </div>
                </div>
                {pipeSel && voompSel && (
                  <div className="shrink-0 flex items-center gap-2">
                    <span className="tabular-nums">
                      dif {fmtBRL(pipeSel.pipe_valor - Number(voompSel.voomp_valor_cobrado))}
                    </span>
                    {classePrevista && (
                      <Badge variant={CLASSE_VARIANT[classePrevista] ?? "muted"}>
                        {CLASSE_LABEL[classePrevista] ?? classePrevista}
                      </Badge>
                    )}
                  </div>
                )}
                <div className="shrink-0 flex items-center gap-1.5">
                  <Button size="sm" onClick={vincular} disabled={!pipeSel || !voompSel || linking || fechado}>
                    <Link2 className="h-4 w-4 mr-1" />{linking ? "Vinculando..." : "Vincular"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { setSelPipe(null); setSelVoomp(null); }}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Só no Pipe ({pipeFiltrado.length})</CardTitle>
            <p className="text-xs text-muted-foreground">Deals comerciais sem venda Voomp correspondente</p>
          </CardHeader>
          <CardContent>
            {loading ? <p>Carregando...</p> : (
              <div className="space-y-1.5 max-h-[600px] overflow-y-auto">
                {pipeFiltrado.map((p) => (
                  <button
                    key={p.pipe_deal_id}
                    onClick={() => setSelPipe(p.pipe_deal_id)}
                    className={`w-full text-left p-3 rounded-md border text-sm transition-colors ${selPipe === p.pipe_deal_id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/30"}`}
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{p.pessoa_nome ?? "—"}</div>
                        <div className="text-xs text-muted-foreground">{p.pipe_cpf ?? "sem CPF"}</div>
                        {voompSel && p._score >= 0.5 && (
                          <Badge variant={p._score >= 0.75 ? "success" : "warning"}>
                            {Math.round(p._score * 100)}% provável
                          </Badge>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono tabular-nums">{fmtBRL(Number(p.pipe_valor))}</div>
                        <div className="text-xs text-muted-foreground">deal #{p.pipe_deal_id}</div>
                        {voompSel && (
                          <div className="text-xs text-muted-foreground tabular-nums">
                            dif {fmtBRL(Number(p.pipe_valor) - Number(voompSel.voomp_valor_cobrado))}
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
                {pipeFiltrado.length === 0 && <p className="text-muted-foreground text-center py-8">Nenhuma venda só no Pipe{busca ? ` para "${busca}"` : ""}.</p>}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Só na Voomp ({voompFiltrado.length})</CardTitle>
            <p className="text-xs text-muted-foreground">Vendas fiscais sem deal Pipe correspondente</p>
          </CardHeader>
          <CardContent>
            {loading ? <p>Carregando...</p> : (
              <div className="space-y-1.5 max-h-[600px] overflow-y-auto">
                {voompFiltrado.map((v) => (
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
                        {pipeSel && v._score >= 0.5 && (
                          <Badge variant={v._score >= 0.75 ? "success" : "warning"}>
                            {Math.round(v._score * 100)}% provável
                          </Badge>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono tabular-nums">{fmtBRL(Number(v.voomp_valor_cobrado))}</div>
                        <div className="text-xs text-muted-foreground">pago {v.voomp_data_pagamento?.slice(0, 10)}</div>
                        {v.voomp_venda_id && (
                          <div className="text-xs text-muted-foreground font-mono">venda {v.voomp_venda_id}</div>
                        )}
                        {(v.qtd_cobrancas ?? 1) > 1 && (
                          <div className="text-xs text-muted-foreground">{v.qtd_cobrancas} cobranças agrupadas</div>
                        )}
                        {pipeSel && (
                          <div className="text-xs text-muted-foreground tabular-nums">
                            dif {fmtBRL(Number(pipeSel.pipe_valor) - Number(v.voomp_valor_cobrado))}
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
                {voompFiltrado.length === 0 && <p className="text-muted-foreground text-center py-8">Nenhuma venda só na Voomp{busca ? ` para "${busca}"` : ""}.</p>}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
