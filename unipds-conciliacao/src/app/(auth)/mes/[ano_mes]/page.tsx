"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useActiveTenant } from "@/lib/use-active-tenant";
import { parsePipeCsv } from "@/lib/csv-parser";
import { tenantById } from "@/lib/tenants";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Upload, Play, Download, CheckCircle, ArrowLeft, AlertCircle, ShieldAlert } from "lucide-react";

type CruzamentoRow = {
  pipe_deal_id: number | null;
  contract_id: string | null;
  status_match: "CASADO" | "ORFAO_PIPE" | "ORFAO_VOOMP";
  pessoa_nome: string | null;
  voomp_aluno_nome: string | null;
  pipe_valor: number | null;
  voomp_valor_contrato: number | null;       // líquido recebido (0 para reembolsados)
  voomp_valor_cobrado_total: number | null;  // bruto cobrado antes de taxas
  voomp_reembolsado: boolean | null;
  divergencia_classe: string | null;
  divergencia_valor: number | null;
  criterio: string | null;
  confianca: number | null;
  voomp_data_pagamento: string | null;
  cross_tenant: boolean | null;
  voomp_tenant_id: string | null;
};

type IngestaoStatus = { fonte_id: string; fonte_nome: string; status: string };

type SuspeitoTenantErrado = {
  pipe_deal_id: number;
  funil: string;
  pipe_nome: string;
  voomp_nome: string;
  pipe_valor: number;
  voomp_valor: number;
  criterio_suspeita: string;
  similaridade_nome: number;
  tenant_pipe: string;
  tenant_voomp: string;
  voomp_contract_id: string;
};

export default function MesPage() {
  const { ano_mes } = useParams<{ ano_mes: string }>();
  const tenantId = useActiveTenant();
  const supabase = createClient();

  const [fechamento, setFechamento] = useState<any>(null);
  const [rows, setRows] = useState<CruzamentoRow[]>([]);
  const [ingestao, setIngestao] = useState<IngestaoStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [filter, setFilter] = useState<"TODOS" | "CASADO" | "ORFAO_PIPE" | "ORFAO_VOOMP" | "MATERIAL">("TODOS");
  const [suspeitos, setSuspeitos] = useState<SuspeitoTenantErrado[]>([]);

  async function load() {
    if (!tenantId) return;
    setLoading(true);

    const [{ data: f }, { data: pipeRows }, { data: voompRows }, { data: ing }, { data: susp }] = await Promise.all([
      supabase.schema("unipds").from("fechamentos_mensais")
        .select("*").eq("tenant_id", tenantId).eq("ano_mes", ano_mes).maybeSingle(),
      supabase.schema("unipds").from("v_cruzamento_pipe")
        .select("*").eq("tenant_id", tenantId).eq("ano_mes", ano_mes),
      supabase.schema("unipds").from("v_cruzamento_voomp")
        .select("*").eq("tenant_id", tenantId).eq("ano_mes", ano_mes).is("link_id", null),
      supabase.schema("unipds").from("ingestao_status")
        .select("fonte_id, status, fontes:fonte_id(nome)")
        .eq("tenant_id", tenantId).eq("ano_mes", ano_mes),
      supabase.schema("unipds").from("v_suspeitos_tenant_errado")
        .select("*").eq("tenant_pipe", tenantId).eq("ano_mes", ano_mes),
    ]);

    setFechamento(f);
    setRows([
      ...((pipeRows ?? []) as any[]),
      ...((voompRows ?? []) as any[]).map((v) => ({
        pipe_deal_id: null,
        contract_id: v.contract_id,
        status_match: "ORFAO_VOOMP" as const,
        pessoa_nome: null,
        voomp_aluno_nome: v.aluno_nome,
        pipe_valor: null,
        voomp_valor_contrato: v.voomp_valor_contrato,
        voomp_valor_cobrado_total: v.voomp_valor_cobrado_total,
        voomp_reembolsado: v.voomp_reembolsado,
        divergencia_classe: null,
        divergencia_valor: null,
        criterio: null,
        confianca: null,
        voomp_data_pagamento: v.data_pagamento,
        cross_tenant: false,
        voomp_tenant_id: null,
      })),
    ]);
    setIngestao(((ing as any[]) ?? []).map((i) => ({
      fonte_id: i.fonte_id, fonte_nome: i.fontes?.nome ?? "?", status: i.status,
    })));
    setSuspeitos((susp ?? []) as SuspeitoTenantErrado[]);
    setLoading(false);
  }

  useEffect(() => { load(); }, [tenantId, ano_mes]);

  async function uploadCsv(file: File) {
    if (!tenantId) return;
    setUploading(true);
    try {
      const text = await file.text();
      const { rows: parsed, errors, unknownFunils } = parsePipeCsv(text);
      const rowsForTenant = parsed.filter((r) => r.tenant_id === tenantId && r.ano_mes === ano_mes);
      if (rowsForTenant.length === 0) {
        alert("Nenhum deal correspondente ao tenant ativo e mês selecionado.");
        return;
      }

      // Full replace: apaga todos os deals existentes do mês antes de inserir.
      // Garante que deals removidos/movidos no Pipe não fiquem stale no DB.
      const { error: delError } = await supabase
        .schema("unipds")
        .from("pipe_deals")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("ano_mes", ano_mes);
      if (delError) throw delError;

      // Insert em chunks de 50 (evita timeout com 6 índices na tabela)
      const chunkSize = 50;
      for (let i = 0; i < rowsForTenant.length; i += chunkSize) {
        const chunk = rowsForTenant.slice(i, i + chunkSize);
        const { error } = await supabase.schema("unipds").from("pipe_deals").insert(chunk);
        if (error) throw error;
      }
      const aviso = unknownFunils.size > 0
        ? `\nFunis ignorados (não mapeados): ${[...unknownFunils].join(", ")}`
        : "";
      alert(`${rowsForTenant.length} deals carregados.${errors.length ? `\n${errors.length} avisos.` : ""}${aviso}`);
      load();
    } catch (e: any) {
      alert(`Erro: ${e.message}`);
    } finally {
      setUploading(false);
    }
  }

  async function rodarCruzamento() {
    if (!tenantId) return;
    setRunning(true);
    const { data, error } = await supabase
      .schema("unipds")
      .rpc("executar_cruzamento", { p_tenant_id: tenantId, p_ano_mes: ano_mes });
    setRunning(false);
    if (error) {
      alert(`Erro: ${error.message}`);
    } else {
      alert(`Cruzamento concluído. Run ID: ${data}`);
      load();
    }
  }

  async function confirmarIngestao(fonte_id: string) {
    if (!tenantId) return;
    const { error } = await supabase.schema("unipds").from("ingestao_status").upsert({
      tenant_id: tenantId, fonte_id, ano_mes, status: "COMPLETA", confirmado_em: new Date().toISOString(),
    }, { onConflict: "tenant_id,fonte_id,ano_mes" });
    if (error) alert(error.message);
    else load();
  }

  async function exportarFechar() {
    setExporting(true);
    const res = await fetch(`/api/export/${ano_mes}?tenant_id=${tenantId}`, { method: "POST" });
    if (!res.ok) {
      alert(`Erro: ${await res.text()}`);
      setExporting(false);
      return;
    }
    const blob = await res.blob();
    const hashHeader = res.headers.get("X-Report-Hash");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `conciliacao_${ano_mes}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    setExporting(false);
    alert(`Relatório gerado.\nHash SHA256: ${hashHeader}`);
    load();
  }

  const filtered = rows.filter((r) => {
    if (filter === "TODOS") return true;
    if (filter === "MATERIAL") return r.divergencia_classe === "MATERIAL";
    return r.status_match === filter;
  });

  const totalPipe        = rows.reduce((s, r) => s + (r.pipe_valor ?? 0), 0);
  const totalVoompBruto  = rows.reduce((s, r) => s + (r.voomp_valor_cobrado_total ?? 0), 0);
  const totalReembolsos  = rows.filter((r) => r.voomp_reembolsado).reduce((s, r) => s + (r.voomp_valor_cobrado_total ?? 0), 0);
  const totalVoompLiquido = rows.reduce((s, r) => s + (r.voomp_valor_contrato ?? 0), 0);
  const casadosPipe  = rows.filter((r) => r.status_match === "CASADO").reduce((s, r) => s + (r.pipe_valor ?? 0), 0);
  const casadosVoomp = rows.filter((r) => r.status_match === "CASADO").reduce((s, r) => s + (r.voomp_valor_cobrado_total ?? 0), 0);
  const orfaosPipe   = rows.filter((r) => r.status_match === "ORFAO_PIPE").reduce((s, r) => s + (r.pipe_valor ?? 0), 0);
  const orfaosVoomp  = rows.filter((r) => r.status_match === "ORFAO_VOOMP").reduce((s, r) => s + (r.voomp_valor_cobrado_total ?? 0), 0);
  const fmt = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  const todasIngestoesOk = ingestao.length >= 1 && ingestao.every((i) => i.status === "COMPLETA");

  return (
    <div className="space-y-6">
      <Link href="/" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4 mr-1" /> Voltar
      </Link>

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{ano_mes}</h1>
        {fechamento && <Badge variant={fechamento.estado === "FECHADO" ? "success" : fechamento.estado === "EM_REVISAO" ? "warning" : "muted"}>{fechamento.estado}</Badge>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-base">1. Ingestão Voomp</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {ingestao.length === 0 && <p className="text-sm text-muted-foreground">Nenhum registro. Confirme manualmente:</p>}
            {ingestao.map((i) => (
              <div key={i.fonte_id} className="flex items-center justify-between text-sm">
                <span>{i.fonte_nome}</span>
                {i.status === "COMPLETA" ? (
                  <Badge variant="success"><CheckCircle className="h-3 w-3 mr-1" />Completa</Badge>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => confirmarIngestao(i.fonte_id)}>Confirmar</Button>
                )}
              </div>
            ))}
            <ConfirmarIngestaoExtra tenantId={tenantId} anoMes={ano_mes} jaConfirmadas={ingestao.map(i=>i.fonte_id)} onDone={load} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">2. CSV Pipe</CardTitle></CardHeader>
          <CardContent>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => { if (e.target.files?.[0]) uploadCsv(e.target.files[0]); e.target.value = ""; }}
            />
            <Button disabled={uploading} className="w-full" variant="outline" onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-4 w-4 mr-2" />{uploading ? "Carregando..." : "Upload CSV"}
            </Button>
            <p className="text-xs text-muted-foreground mt-2">Apenas deals do tenant e mês ativos serão importados.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">3. Cruzamento</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <Button onClick={rodarCruzamento} disabled={running} className="w-full">
              <Play className="h-4 w-4 mr-2" />{running ? "Rodando..." : "Rodar cruzamento"}</Button>
            <Button onClick={exportarFechar} disabled={exporting || !todasIngestoesOk} className="w-full" variant="success">
              <Download className="h-4 w-4 mr-2" />{exporting ? "Gerando..." : "Exportar e fechar"}
            </Button>
            {!todasIngestoesOk && <p className="text-xs text-warning">Confirme todas as ingestões antes de fechar.</p>}
          </CardContent>
        </Card>
      </div>

      {suspeitos.length > 0 && (
        <Card className="border-warning/50 bg-warning/5">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2 text-warning">
              <ShieldAlert className="h-4 w-4" />
              {suspeitos.length} suspeito{suspeitos.length > 1 ? "s" : ""} de tenant errado
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Deals ORFAO_PIPE neste tenant que batem por CPF ou email com alunos ORFAO_VOOMP no outro tenant.
              Vincule para registrar que o deal foi fechado no produto errado — fica marcado como <strong>CASADO ⚠ TENANT</strong> no relatório.
            </p>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left border-b border-border">
                  <tr>
                    <th className="py-2 pr-4">Deal Pipe</th>
                    <th className="py-2 pr-4">Nome Pipe</th>
                    <th className="py-2 pr-4">Nome Voomp</th>
                    <th className="py-2 pr-4">Funil</th>
                    <th className="py-2 pr-4">Tenant Voomp</th>
                    <th className="py-2 pr-4 text-right">Pipe R$</th>
                    <th className="py-2 pr-4 text-right">Voomp R$</th>
                    <th className="py-2 pr-4">Match por</th>
                    <th className="py-2 pr-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {suspeitos.map((s) => (
                    <tr key={s.pipe_deal_id} className="border-b border-border/50">
                      <td className="py-2 pr-4 font-mono text-xs">{s.pipe_deal_id}</td>
                      <td className="py-2 pr-4 max-w-[160px] truncate" title={s.pipe_nome}>{s.pipe_nome}</td>
                      <td className="py-2 pr-4 max-w-[160px] truncate" title={s.voomp_nome}>{s.voomp_nome}</td>
                      <td className="py-2 pr-4 text-xs">{s.funil}</td>
                      <td className="py-2 pr-4"><Badge variant="warning">{tenantById(s.tenant_voomp)?.curto ?? s.tenant_voomp.slice(0,8)}</Badge></td>
                      <td className="py-2 pr-4 text-right tabular-nums">R$ {Number(s.pipe_valor).toFixed(2)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">R$ {Number(s.voomp_valor).toFixed(2)}</td>
                      <td className="py-2 pr-4"><Badge variant="muted">{s.criterio_suspeita}</Badge></td>
                      <td className="py-2 pr-4">
                        <VincularCrossTenant
                          suspeito={s}
                          tenantId={tenantId}
                          anoMes={ano_mes}
                          onDone={load}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {!loading && rows.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {/* ── Pipe ── */}
          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">Total Pipe</CardTitle></CardHeader>
            <CardContent>
              <p className="text-xl font-semibold tabular-nums">{fmt(totalPipe)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{rows.filter(r => r.pipe_valor != null).length} deals</p>
            </CardContent>
          </Card>

          {/* ── Voomp Bruto ── */}
          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">Voomp Cobrado</CardTitle></CardHeader>
            <CardContent>
              <p className="text-xl font-semibold tabular-nums">{fmt(totalVoompBruto)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{rows.filter(r => r.voomp_valor_cobrado_total != null).length} contratos · bruto s/ taxas</p>
            </CardContent>
          </Card>

          {/* ── Reembolsos ── */}
          <Card className={totalReembolsos > 0 ? "border-destructive/40 bg-destructive/5" : ""}>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">Reembolsos</CardTitle></CardHeader>
            <CardContent>
              <p className={`text-xl font-semibold tabular-nums ${totalReembolsos > 0 ? "text-destructive" : ""}`}>
                {totalReembolsos > 0 ? `- ${fmt(totalReembolsos)}` : fmt(0)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {rows.filter(r => r.voomp_reembolsado).length} contrato{rows.filter(r => r.voomp_reembolsado).length !== 1 ? "s" : ""} reembolsado{rows.filter(r => r.voomp_reembolsado).length !== 1 ? "s" : ""}
              </p>
            </CardContent>
          </Card>

          {/* ── Voomp Líquido ── */}
          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">Voomp Recebido</CardTitle></CardHeader>
            <CardContent>
              <p className="text-xl font-semibold tabular-nums">{fmt(totalVoompLiquido)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">líquido após taxas e reembolsos</p>
            </CardContent>
          </Card>

          {/* ── Casados ── */}
          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">Casados</CardTitle></CardHeader>
            <CardContent>
              <p className="text-xl font-semibold tabular-nums">{fmt(casadosPipe)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Pipe · Voomp: {fmt(casadosVoomp)}</p>
            </CardContent>
          </Card>

          {/* ── Órfãos ── */}
          <Card className={orfaosPipe + orfaosVoomp > 0 ? "border-warning/50 bg-warning/5" : ""}>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">Órfãos</CardTitle></CardHeader>
            <CardContent>
              <p className="text-xl font-semibold tabular-nums">{fmt(orfaosPipe + orfaosVoomp)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Pipe: {fmt(orfaosPipe)} · Voomp: {fmt(orfaosVoomp)}</p>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Resultado ({filtered.length} de {rows.length})</CardTitle>
            <div className="flex gap-1 text-xs">
              {(["TODOS", "CASADO", "ORFAO_PIPE", "ORFAO_VOOMP", "MATERIAL"] as const).map((f) => (
                <Button key={f} variant={filter === f ? "default" : "outline"} size="sm" onClick={() => setFilter(f)}>
                  {f.replace("_", " ")}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground">Carregando...</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left border-b border-border">
                  <tr>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Pipe</th>
                    <th className="py-2 pr-4">Voomp</th>
                    <th className="py-2 pr-4 text-right">Pipe R$</th>
                    <th className="py-2 pr-4 text-right">Voomp R$</th>
                    <th className="py-2 pr-4 text-right">Diferença</th>
                    <th className="py-2 pr-4">Critério</th>
                    <th className="py-2 pr-4">Divergência</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r, idx) => (
                    <tr key={idx} className="border-b border-border/50">
                      <td className="py-2 pr-4">
                        {r.cross_tenant ? (
                          <Badge variant="destructive" title={`Deal fechado no tenant errado — aluno pertence a ${tenantById(r.voomp_tenant_id)?.curto ?? "outro tenant"}`}>
                            CASADO ⚠ TENANT
                          </Badge>
                        ) : (
                          <Badge variant={r.status_match === "CASADO" ? "success" : "warning"}>{r.status_match.replace("_"," ")}</Badge>
                        )}
                      </td>
                      <td className="py-2 pr-4 max-w-[180px] truncate" title={r.pessoa_nome ?? ""}>{r.pessoa_nome ?? "—"}</td>
                      <td className="py-2 pr-4 max-w-[180px] truncate" title={r.voomp_aluno_nome ?? ""}>{r.voomp_aluno_nome ?? "—"}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{r.pipe_valor != null ? `R$ ${r.pipe_valor.toFixed(2)}` : "—"}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{r.voomp_valor_contrato != null ? `R$ ${Number(r.voomp_valor_contrato).toFixed(2)}` : "—"}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{r.divergencia_valor != null ? `R$ ${Number(r.divergencia_valor).toFixed(2)}` : "—"}</td>
                      <td className="py-2 pr-4">{r.criterio ?? "—"}{r.confianca ? ` (${r.confianca}%)` : ""}</td>
                      <td className="py-2 pr-4">
                        {r.divergencia_classe && (
                          <Badge variant={r.divergencia_classe === "IDENTICO" ? "success" : r.divergencia_classe === "CENTAVOS" ? "muted" : r.divergencia_classe === "CUPOM_PROVAVEL" ? "warning" : "destructive"}>
                            {r.divergencia_classe}
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Link href={`/mes/${ano_mes}/conciliacao`}>
          <Button variant="outline"><AlertCircle className="h-4 w-4 mr-2" />Conciliação manual de órfãos</Button>
        </Link>
      </div>
    </div>
  );
}

function VincularCrossTenant({ suspeito, tenantId, anoMes, onDone }: {
  suspeito: SuspeitoTenantErrado;
  tenantId: string | null;
  anoMes: string;
  onDone: () => void;
}) {
  const supabase = createClient();
  const [loading, setLoading] = useState(false);

  async function vincular() {
    if (!tenantId) return;
    if (!confirm(
      `Registrar que o deal Pipe ${suspeito.pipe_deal_id} foi fechado no tenant errado?\n` +
      `O aluno "${suspeito.voomp_nome}" pertence ao tenant ${tenantById(suspeito.tenant_voomp)?.curto ?? suspeito.tenant_voomp}.\n\n` +
      `O vínculo será registrado como CROSS_TENANT — ficará marcado no relatório como "CASADO ⚠ TENANT".`
    )) return;
    setLoading(true);
    const div = Number(suspeito.pipe_valor) - Number(suspeito.voomp_valor);
    const divPct = Number(suspeito.pipe_valor) !== 0 ? Math.abs(div) / Number(suspeito.pipe_valor) : 1;
    const classe = div === 0 ? "IDENTICO" : Math.abs(div) < 1 ? "CENTAVOS" : divPct >= 0.05 && divPct <= 0.20 ? "CUPOM_PROVAVEL" : "MATERIAL";
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.schema("unipds").from("conciliacao_links").insert({
      tenant_id: tenantId,
      ano_mes: anoMes,
      pipe_deal_id: suspeito.pipe_deal_id,
      contract_id: suspeito.voomp_contract_id,
      criterio: "CROSS_TENANT",
      confianca: 100,
      origem: "MANUAL",
      cross_tenant: true,
      valor_pipe: suspeito.pipe_valor,
      valor_voomp: suspeito.voomp_valor,
      divergencia_valor: Number(div.toFixed(2)),
      divergencia_classe: classe,
      observacao: `Deal fechado no tenant errado. Pipe: ${suspeito.tenant_pipe} / Voomp: ${suspeito.tenant_voomp}`,
      created_by: user?.id ?? null,
    });
    setLoading(false);
    if (error) alert(error.message);
    else onDone();
  }

  return (
    <Button size="sm" variant="destructive" onClick={vincular} disabled={loading}>
      {loading ? "..." : "Registrar erro"}
    </Button>
  );
}

function ConfirmarIngestaoExtra({ tenantId, anoMes, jaConfirmadas, onDone }:
  { tenantId: string | null; anoMes: string; jaConfirmadas: string[]; onDone: () => void }) {
  const supabase = createClient();
  const [fontes, setFontes] = useState<{ fonte_id: string; nome: string }[]>([]);
  useEffect(() => {
    if (!tenantId) return;
    supabase.schema("unipds").from("fontes")
      .select("fonte_id,nome").eq("tenant_id", tenantId).eq("ativo", true)
      .then(({ data }) => setFontes((data ?? []) as any));
  }, [tenantId]);
  const pendentes = fontes.filter((f) => !jaConfirmadas.includes(f.fonte_id));
  if (pendentes.length === 0) return null;
  return (
    <div className="pt-2 border-t border-border space-y-1.5">
      {pendentes.map((f) => (
        <div key={f.fonte_id} className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{f.nome}</span>
          <Button size="sm" variant="outline" onClick={async () => {
            await supabase.schema("unipds").from("ingestao_status").upsert({
              tenant_id: tenantId, fonte_id: f.fonte_id, ano_mes: anoMes, status: "COMPLETA", confirmado_em: new Date().toISOString(),
            }, { onConflict: "tenant_id,fonte_id,ano_mes" });
            onDone();
          }}>Confirmar</Button>
        </div>
      ))}
    </div>
  );
}
