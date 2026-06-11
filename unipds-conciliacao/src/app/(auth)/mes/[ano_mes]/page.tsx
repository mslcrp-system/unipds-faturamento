"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useActiveTenant } from "@/lib/use-active-tenant";
import { parsePipeCsv } from "@/lib/csv-parser";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Upload, Play, Download, CheckCircle, ArrowLeft, AlertCircle, Camera } from "lucide-react";

type CruzamentoRow = {
  pipe_deal_id:        number | null;
  snapshot_id:         string | null;
  status_match:        "CASADO" | "ORFAO_PIPE" | "ORFAO_VOOMP";
  pessoa_nome:         string | null;
  voomp_aluno_nome:    string | null;
  pipe_valor:          number | null;
  voomp_valor_cobrado: number | null;   // valor gerencial — base da conciliação (líquido p/ Único; reembolsado = bruto)
  voomp_valor_recebido:number | null;
  voomp_reembolsado:   boolean | null;
  divergencia_classe:  string | null;
  divergencia_valor:   number | null;
  criterio:            string | null;
  confianca:           number | null;
  voomp_data_pagamento:string | null;
  pipe_cpf:            string | null;
  voomp_cpf:           string | null;
  produto_nome:        string | null;
  tipo_cobranca:       string | null;
  voomp_venda_id:      string | null;   // ID Venda Voomp (NULL em ORFAO_PIPE)
  voomp_contrato_id:   string | null;   // ID Contrato Voomp (NULL em venda única)
  link_id:             string | null;
  qtd_cobrancas:       number | null;   // > 1 = pagamento dividido agrupado
  vendas_agrupadas:    string[] | null; // IDs das vendas fundidas no agrupamento
};

// Mensagem amigável para a trava de mês fechado (trigger P0001 do banco)
function friendlyError(message: string): string {
  if (message.includes("FECHADO")) {
    return "Este mês está FECHADO — alterações bloqueadas. A reabertura é feita pelo gestor do banco.";
  }
  return `Erro: ${message}`;
}

export default function MesPage() {
  const { ano_mes } = useParams<{ ano_mes: string }>();
  const tenantId = useActiveTenant();
  const supabase = createClient();

  const [fechamento, setFechamento] = useState<any>(null);
  const [rows, setRows] = useState<CruzamentoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [gerandoSnapshot, setGerandoSnapshot] = useState(false);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState<"TODOS" | "CASADO" | "ORFAO_PIPE" | "ORFAO_VOOMP" | "MATERIAL">("TODOS");

  async function load() {
    if (!tenantId) return;
    setLoading(true);

    const [{ data: f }, { data: cruzRows }] = await Promise.all([
      supabase.schema("conciliacao").from("fechamentos_mensais")
        .select("*").eq("tenant_id", tenantId).eq("ano_mes", ano_mes).maybeSingle(),
      supabase.schema("conciliacao").from("v_cruzamento")
        .select("*").eq("tenant_id", tenantId).eq("ano_mes", ano_mes),
    ]);

    setFechamento(f);
    setRows((cruzRows ?? []) as CruzamentoRow[]);
    setLoading(false);
  }

  useEffect(() => { load(); }, [tenantId, ano_mes]); // eslint-disable-line react-hooks/exhaustive-deps

  async function uploadCsv(file: File) {
    if (!tenantId) return;
    setUploading(true);
    try {
      const text = await file.text();
      const { rows: parsed, errors, unknownFunils, totalLinhas } = parsePipeCsv(text);
      const rowsForTenant = parsed.filter((r) => r.tenant_id === tenantId && r.ano_mes === ano_mes);
      if (rowsForTenant.length === 0) {
        alert("Nenhum deal correspondente ao tenant ativo e mês selecionado.");
        return;
      }

      // Auditoria: hash SHA-256 do arquivo + contagens em pipe_imports
      const hashBuf = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      const sha256 = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
      const { data: { user } } = await supabase.auth.getUser();
      const { data: imp, error: impError } = await supabase
        .schema("conciliacao")
        .from("pipe_imports")
        .insert({
          tenant_id: tenantId,
          ano_mes,
          nome_arquivo: file.name,
          sha256_hash: sha256,
          total_linhas_csv: totalLinhas,
          linhas_importadas: rowsForTenant.length,
          linhas_descartadas: totalLinhas - rowsForTenant.length,
          descarte_detalhe: {
            erros_parser: errors.length,
            fora_do_tenant_mes: parsed.length - rowsForTenant.length,
            funis_desconhecidos: [...unknownFunils],
          },
          imported_by: user?.id ?? null,
        })
        .select("import_id")
        .single();
      if (impError) throw impError;

      // Full replace: apaga todos os deals existentes do mês antes de inserir.
      const { error: delError } = await supabase
        .schema("conciliacao")
        .from("pipe_deals")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("ano_mes", ano_mes);
      if (delError) throw delError;

      // Insert em chunks de 50, cada deal apontando para o import de origem
      const withImport = rowsForTenant.map((r) => ({ ...r, import_id: imp.import_id }));
      const chunkSize = 50;
      for (let i = 0; i < withImport.length; i += chunkSize) {
        const chunk = withImport.slice(i, i + chunkSize);
        const { error } = await supabase.schema("conciliacao").from("pipe_deals").insert(chunk);
        if (error) throw error;
      }
      const aviso = unknownFunils.size > 0
        ? `\nFunis ignorados (não mapeados): ${[...unknownFunils].join(", ")}`
        : "";
      alert(
        `${rowsForTenant.length} deals carregados de ${totalLinhas} linhas do CSV.` +
        `${errors.length ? `\n${errors.length} avisos.` : ""}${aviso}` +
        `\nHash do arquivo: ${sha256.slice(0, 12)}…`
      );
      load();
    } catch (e: any) {
      alert(friendlyError(e.message));
    } finally {
      setUploading(false);
    }
  }

  async function gerarSnapshotVoomp() {
    if (!tenantId) return;
    if (!confirm(
      `Gerar snapshot Voomp para ${ano_mes}?\n\n` +
      `Serão capturadas todas as vendas com data de pagamento no mês:\n` +
      `  • À vista: qualquer charge paga no mês\n` +
      `  • Assinatura: apenas parcela 1 paga no mês\n\n` +
      `Esta ação é imutável — o snapshot não pode ser regenerado depois.`
    )) return;
    setGerandoSnapshot(true);
    const { error } = await (supabase.schema("conciliacao") as any).rpc("gerar_snapshot_voomp", {
      p_tenant_id: tenantId,
      p_ano_mes: ano_mes,
    });
    setGerandoSnapshot(false);
    if (error) alert(friendlyError(error.message));
    else load();
  }

  async function rodarCruzamento() {
    if (!tenantId) return;
    setRunning(true);
    const { data, error } = await (supabase.schema("conciliacao") as any).rpc("executar_cruzamento", {
      p_tenant_id: tenantId,
      p_ano_mes: ano_mes,
    });
    setRunning(false);
    if (error) alert(friendlyError(error.message));
    else { alert(`Cruzamento concluído. ${data ?? 0} links automáticos gerados.`); load(); }
  }

  async function exportarFechar() {
    setExporting(true);
    const res = await fetch(`/api/export/${ano_mes}?tenant_id=${tenantId}`, { method: "POST" });
    if (!res.ok) { alert(`Erro: ${await res.text()}`); setExporting(false); return; }
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

  const pipeCount      = rows.filter((r) => r.pipe_valor != null).length;
  const voompCount     = rows.filter((r) => r.voomp_valor_cobrado != null).length;
  const totalPipe      = rows.reduce((s, r) => s + (r.pipe_valor ?? 0), 0);
  // valor_cobrado = valor gerencial (base de conciliação); reembolsados carregam o bruto e são excluídos do total
  const totalVoompGerencial = rows.filter((r) => !r.voomp_reembolsado).reduce((s, r) => s + (r.voomp_valor_cobrado ?? 0), 0);
  const totalReembolsos= rows.filter((r) => r.voomp_reembolsado).reduce((s, r) => s + (r.voomp_valor_cobrado ?? 0), 0);
  const casadosPipe    = rows.filter((r) => r.status_match === "CASADO").reduce((s, r) => s + (r.pipe_valor ?? 0), 0);
  const casadosVoomp   = rows.filter((r) => r.status_match === "CASADO").reduce((s, r) => s + (r.voomp_valor_cobrado ?? 0), 0);
  const orfaosPipe     = rows.filter((r) => r.status_match === "ORFAO_PIPE").reduce((s, r) => s + (r.pipe_valor ?? 0), 0);
  const orfaosVoomp    = rows.filter((r) => r.status_match === "ORFAO_VOOMP").reduce((s, r) => s + (r.voomp_valor_cobrado ?? 0), 0);
  const fmt = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  const snapshotOk  = !!fechamento?.snapshot_gerado_em;
  const pipeOk      = pipeCount > 0;
  const fechado     = fechamento?.estado === "FECHADO";
  const prontoParaFechar = snapshotOk && pipeOk && !fechado;

  return (
    <div className="space-y-6">
      <Link href="/" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4 mr-1" /> Voltar
      </Link>

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{ano_mes}</h1>
        {fechamento && (
          <Badge variant={fechamento.estado === "FECHADO" ? "success" : fechamento.estado === "EM_REVISAO" ? "warning" : "muted"}>
            {fechamento.estado}
          </Badge>
        )}
      </div>

      {fechado && (
        <Card className="border-success/40 bg-success/5">
          <CardContent className="p-4 text-sm flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-600 shrink-0" />
            <span>
              Mês fechado em {fechamento.fechado_em ? new Date(fechamento.fechado_em).toLocaleString("pt-BR") : "—"} — somente leitura.
              Upload, snapshot, cruzamento e vínculos estão bloqueados. Reabertura é feita pelo gestor do banco.
            </span>
          </CardContent>
        </Card>
      )}

      {/* ── Passos ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* 1. CSV Pipe */}
        <Card>
          <CardHeader><CardTitle className="text-base">1. CSV Pipe</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => { if (e.target.files?.[0]) uploadCsv(e.target.files[0]); e.target.value = ""; }}
            />
            <Button disabled={uploading || fechado} className="w-full" variant="outline" onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-4 w-4 mr-2" />{uploading ? "Carregando..." : "Upload CSV"}
            </Button>
            {pipeOk && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <CheckCircle className="h-3 w-3 text-green-500" />
                {pipeCount} deals carregados
              </p>
            )}
            <p className="text-xs text-muted-foreground">Full replace: substitui todos os deals do mês.</p>
          </CardContent>
        </Card>

        {/* 2. Snapshot Voomp */}
        <Card>
          <CardHeader><CardTitle className="text-base">2. Snapshot Voomp</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {snapshotOk ? (
              <p className="text-sm flex items-center gap-2 text-green-600">
                <CheckCircle className="h-4 w-4" />
                Snapshot gerado em {new Date(fechamento.snapshot_gerado_em).toLocaleString("pt-BR")}
              </p>
            ) : (
              <>
                <Button onClick={gerarSnapshotVoomp} disabled={gerandoSnapshot || fechado} className="w-full" variant="outline">
                  <Camera className="h-4 w-4 mr-2" />{gerandoSnapshot ? "Gerando..." : "Gerar snapshot"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Materializa vendas do mês do Voomp. Ação imutável.
                </p>
              </>
            )}
            {snapshotOk && (
              <p className="text-xs text-muted-foreground">{voompCount} contratos · imutável</p>
            )}
          </CardContent>
        </Card>

        {/* 3. Cruzamento */}
        <Card>
          <CardHeader><CardTitle className="text-base">3. Cruzamento</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <Button onClick={rodarCruzamento} disabled={running || !snapshotOk || !pipeOk || fechado} className="w-full">
              <Play className="h-4 w-4 mr-2" />{running ? "Rodando..." : "Rodar cruzamento"}
            </Button>
            <Button
              onClick={exportarFechar}
              disabled={exporting || !prontoParaFechar}
              className="w-full"
              variant="success"
            >
              <Download className="h-4 w-4 mr-2" />{exporting ? "Gerando..." : "Exportar e fechar"}
            </Button>
            {!prontoParaFechar && !fechado && (
              <p className="text-xs text-warning">
                {!pipeOk ? "Faça upload do CSV Pipe. " : ""}
                {!snapshotOk ? "Gere o snapshot Voomp." : ""}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Cards financeiros ───────────────────────────────────────── */}
      {!loading && rows.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">Total Pipe</CardTitle></CardHeader>
            <CardContent>
              <p className="text-xl font-semibold tabular-nums">{fmt(totalPipe)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{pipeCount} deals</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">Voomp Gerencial</CardTitle></CardHeader>
            <CardContent>
              <p className="text-xl font-semibold tabular-nums">{fmt(totalVoompGerencial)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{voompCount} contratos · base da conciliação</p>
            </CardContent>
          </Card>

          <Card className={totalReembolsos > 0 ? "border-destructive/40 bg-destructive/5" : ""}>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">Reembolsos</CardTitle></CardHeader>
            <CardContent>
              <p className={`text-xl font-semibold tabular-nums ${totalReembolsos > 0 ? "text-destructive" : ""}`}>
                {totalReembolsos > 0 ? `- ${fmt(totalReembolsos)}` : fmt(0)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {rows.filter((r) => r.voomp_reembolsado).length} reembolsado{rows.filter((r) => r.voomp_reembolsado).length !== 1 ? "s" : ""}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">Casados</CardTitle></CardHeader>
            <CardContent>
              <p className="text-xl font-semibold tabular-nums">{fmt(casadosPipe)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Pipe · Voomp: {fmt(casadosVoomp)}</p>
            </CardContent>
          </Card>

          <Card className={orfaosPipe + orfaosVoomp > 0 ? "border-warning/50 bg-warning/5" : ""}>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">Órfãos</CardTitle></CardHeader>
            <CardContent>
              <p className="text-xl font-semibold tabular-nums">{fmt(orfaosPipe + orfaosVoomp)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Pipe: {fmt(orfaosPipe)} · Voomp: {fmt(orfaosVoomp)}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Tabela de resultado ─────────────────────────────────────── */}
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
                    <th className="py-2 pr-4 text-right">Voomp Gerencial</th>
                    <th className="py-2 pr-4 text-right">Diferença</th>
                    <th className="py-2 pr-4">Critério</th>
                    <th className="py-2 pr-4">Divergência</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r, idx) => (
                    <tr key={idx} className={`border-b border-border/50 ${r.voomp_reembolsado ? "opacity-60" : ""}`}>
                      <td className="py-2 pr-4">
                        <Badge variant={r.status_match === "CASADO" ? "success" : "warning"}>
                          {r.status_match.replace("_", " ")}
                          {r.voomp_reembolsado ? " ↩" : ""}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 max-w-[180px] truncate" title={r.pessoa_nome ?? ""}>{r.pessoa_nome ?? "—"}</td>
                      <td className="py-2 pr-4 max-w-[200px]">
                        <div className="truncate" title={r.voomp_aluno_nome ?? ""}>{r.voomp_aluno_nome ?? "—"}</div>
                        {r.voomp_venda_id && (
                          <div className="text-xs text-muted-foreground font-mono">
                            venda {r.voomp_venda_id}
                            {r.voomp_contrato_id ? ` · contrato ${r.voomp_contrato_id}` : ""}
                          </div>
                        )}
                        {(r.qtd_cobrancas ?? 1) > 1 && (
                          <Badge
                            variant="muted"
                            title={`Pagamento dividido — vendas: ${(r.vendas_agrupadas ?? []).join(", ")}`}
                          >
                            {r.qtd_cobrancas} cobranças agrupadas
                          </Badge>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{r.pipe_valor != null ? `R$ ${Number(r.pipe_valor).toFixed(2)}` : "—"}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{r.voomp_valor_cobrado != null ? `R$ ${Number(r.voomp_valor_cobrado).toFixed(2)}` : "—"}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{r.divergencia_valor != null ? `R$ ${Number(r.divergencia_valor).toFixed(2)}` : "—"}</td>
                      <td className="py-2 pr-4">{r.criterio ?? "—"}{r.confianca ? ` (${r.confianca}%)` : ""}</td>
                      <td className="py-2 pr-4">
                        {r.divergencia_classe && (
                          <Badge variant={
                            r.divergencia_classe === "IDENTICO" ? "success"
                            : r.divergencia_classe === "CENTAVOS" || r.divergencia_classe === "PEQUENA" ? "muted"
                            : r.divergencia_classe === "CUPOM_PROVAVEL" ? "warning"
                            : "destructive"
                          }>
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

      {!fechado && (
        <div className="flex justify-end">
          <Link href={`/mes/${ano_mes}/conciliacao`}>
            <Button variant="outline"><AlertCircle className="h-4 w-4 mr-2" />Conciliação manual de órfãos</Button>
          </Link>
        </div>
      )}
    </div>
  );
}
