"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useActiveTenant } from "@/lib/use-active-tenant";
import { parsePipeCsv } from "@/lib/csv-parser";
import { tenantById } from "@/lib/tenants";
import { classificarDivergencia, CLASSE_LABEL, CLASSE_VARIANT, CRITERIO_LABEL, fmtBRL, mesLabel } from "@/lib/conciliacao-ui";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Upload, Play, Download, CheckCircle, ArrowLeft, AlertCircle,
  Camera, Search, Lock, ShieldAlert, FileCheck,
} from "lucide-react";

type CruzamentoRow = {
  pipe_deal_id:        number | null;
  snapshot_id:         string | null;
  status_match:        "CASADO" | "ORFAO_PIPE" | "ORFAO_VOOMP";
  pessoa_nome:         string | null;
  voomp_aluno_nome:    string | null;
  pipe_valor:          number | null;
  voomp_valor_cobrado: number | null;   // valor gerencial — base da conciliação
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
  voomp_venda_id:      string | null;
  voomp_contrato_id:   string | null;
  link_id:             string | null;
  cross_tenant:        boolean | null;
  voomp_tenant_id:     string | null;
  qtd_cobrancas:       number | null;
  vendas_agrupadas:    string[] | null;
  divergencia_liquido: number | null;   // pd.valor − líquido cheio (semântica do relatório de comissão)
  registro_bruto:      boolean | null;  // sentinela: deal registrado pelo bruto (esperado: sempre false)
  voomp_valor_bruto:   number | null;   // bruto cheio; taxa = valor_bruto − valor_cobrado
};

type PipeImport = {
  nome_arquivo: string;
  sha256_hash: string;
  total_linhas_csv: number | null;
  linhas_importadas: number | null;
  linhas_descartadas: number | null;
  imported_at: string;
};

type Suspeito = {
  tenant_pipe: string;
  tenant_voomp: string;
  ano_mes: string;
  pipe_deal_id: number;
  funil: string | null;
  proprietario: string | null;
  pipe_nome: string | null;
  voomp_nome: string | null;
  pipe_valor: number;
  voomp_valor: number;
  snapshot_id: string;
  voomp_venda_id: string | null;
  criterio_suspeita: string;
};

type Filtro = "TODOS" | "CONCILIADO" | "SO_PIPE" | "SO_VOOMP" | "MATERIAL" | "REEMBOLSO" | "REGISTRO_BRUTO";

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
  const tenant = tenantById(tenantId);

  const [fechamento, setFechamento] = useState<any>(null);
  const [rows, setRows] = useState<CruzamentoRow[]>([]);
  const [ultimoImport, setUltimoImport] = useState<PipeImport | null>(null);
  const [suspeitos, setSuspeitos] = useState<Suspeito[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [gerandoSnapshot, setGerandoSnapshot] = useState(false);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [linkingCross, setLinkingCross] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [filtro, setFiltro] = useState<Filtro>("TODOS");
  const [busca, setBusca] = useState("");

  async function load() {
    if (!tenantId) return;
    setLoading(true);

    const [{ data: f }, { data: cruzRows }, { data: imp }, { data: susp }] = await Promise.all([
      supabase.schema("conciliacao").from("fechamentos_mensais")
        .select("*").eq("tenant_id", tenantId).eq("ano_mes", ano_mes).maybeSingle(),
      supabase.schema("conciliacao").from("v_cruzamento")
        .select("*").eq("tenant_id", tenantId).eq("ano_mes", ano_mes),
      supabase.schema("conciliacao").from("pipe_imports")
        .select("nome_arquivo, sha256_hash, total_linhas_csv, linhas_importadas, linhas_descartadas, imported_at")
        .eq("tenant_id", tenantId).eq("ano_mes", ano_mes)
        .order("imported_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.schema("conciliacao").from("v_suspeitos_tenant_errado")
        .select("*").eq("tenant_pipe", tenantId).eq("ano_mes", ano_mes),
    ]);

    setFechamento(f);
    setRows((cruzRows ?? []) as CruzamentoRow[]);
    setUltimoImport((imp ?? null) as PipeImport | null);
    setSuspeitos((susp ?? []) as Suspeito[]);
    setLoading(false);
  }

  useEffect(() => { load(); }, [tenantId, ano_mes]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Ações ────────────────────────────────────────────────────────

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
        .schema("conciliacao").from("pipe_deals")
        .delete().eq("tenant_id", tenantId).eq("ano_mes", ano_mes);
      if (delError) throw delError;

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
        `${rowsForTenant.length} deals importados de ${totalLinhas} linhas do CSV.` +
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
      `Gerar a fotografia Voomp de ${mesLabel(ano_mes)}?\n\n` +
      `Serão capturadas todas as vendas com pagamento no mês\n` +
      `(à vista e parcela 1 de assinaturas).\n\n` +
      `A fotografia é imutável — não pode ser regenerada pela tela.`
    )) return;
    setGerandoSnapshot(true);
    const { error } = await (supabase.schema("conciliacao") as any).rpc("gerar_snapshot_voomp", {
      p_tenant_id: tenantId, p_ano_mes: ano_mes,
    });
    setGerandoSnapshot(false);
    if (error) alert(friendlyError(error.message));
    else load();
  }

  async function rodarCruzamento() {
    if (!tenantId) return;
    setRunning(true);
    const { data, error } = await (supabase.schema("conciliacao") as any).rpc("executar_cruzamento", {
      p_tenant_id: tenantId, p_ano_mes: ano_mes,
    });
    setRunning(false);
    if (error) alert(friendlyError(error.message));
    else { alert(`Cruzamento concluído: ${data ?? 0} vínculos automáticos.`); load(); }
  }

  async function vincularCrossTenant(s: Suspeito) {
    if (!tenantId) return;
    const outroTenant = tenantById(s.tenant_voomp)?.curto ?? "outro tenant";
    if (!confirm(
      `Registrar que o deal ${s.pipe_deal_id} (${s.pipe_nome ?? "—"}) foi fechado no funil errado?\n\n` +
      `O aluno "${s.voomp_nome ?? "—"}" pertence ao tenant ${outroTenant}.\n` +
      `O vínculo será marcado como "Outro tenant" no resultado e no relatório.`
    )) return;
    setLinkingCross(s.pipe_deal_id);
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.schema("conciliacao").from("conciliacao_links").insert({
      tenant_id: tenantId,
      ano_mes,
      pipe_deal_id: s.pipe_deal_id,
      snapshot_id: s.snapshot_id,
      criterio: "CROSS_TENANT",
      confianca: 100,
      divergencia_valor: Number((s.pipe_valor - Number(s.voomp_valor)).toFixed(2)),
      divergencia_classe: classificarDivergencia(s.pipe_valor, Number(s.voomp_valor)),
      cross_tenant: true,
      created_by: user?.id ?? null,
    });
    setLinkingCross(null);
    if (error) alert(friendlyError(error.message));
    else load();
  }

  async function exportarFechar() {
    const pendentes = orfaosPipeCount + orfaosVoompAtivosCount;
    const materiais = rows.filter((r) => r.divergencia_classe === "MATERIAL").length;
    if (!confirm(
      `Fechar ${mesLabel(ano_mes)}?\n\n` +
      `Pendências que ficarão registradas no relatório:\n` +
      `  • ${pendentes} venda(s) sem par (${orfaosPipeCount} só no Pipe, ${orfaosVoompAtivosCount} só na Voomp)\n` +
      `  • ${materiais} divergência(s) material(is)\n\n` +
      `Após o fechamento o mês fica somente leitura e o relatório\n` +
      `Excel é gerado com hash de auditoria.`
    )) return;
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
    alert(`Mês fechado e relatório gerado.\nHash de auditoria: ${hashHeader}`);
    load();
  }

  // ── Derivados ────────────────────────────────────────────────────

  const pipeCount   = rows.filter((r) => r.pipe_valor != null).length;
  const voompCount  = rows.filter((r) => r.voomp_valor_cobrado != null).length;
  const casados     = rows.filter((r) => r.status_match === "CASADO");
  const orfaosPipeCount       = rows.filter((r) => r.status_match === "ORFAO_PIPE").length;
  const orfaosVoompAtivosCount = rows.filter((r) => r.status_match === "ORFAO_VOOMP" && !r.voomp_reembolsado).length;
  const reembolsosCount = rows.filter((r) => r.voomp_reembolsado).length;

  const totalPipe           = rows.reduce((s, r) => s + (r.pipe_valor ?? 0), 0);
  const totalVoompGerencial = rows.filter((r) => !r.voomp_reembolsado).reduce((s, r) => s + (r.voomp_valor_cobrado ?? 0), 0);
  const totalReembolsos     = rows.filter((r) => r.voomp_reembolsado).reduce((s, r) => s + (r.voomp_valor_cobrado ?? 0), 0);
  const casadosPipe         = casados.reduce((s, r) => s + (r.pipe_valor ?? 0), 0);
  const casadosVoomp        = casados.reduce((s, r) => s + (r.voomp_valor_cobrado ?? 0), 0);
  const orfaosPipeValor     = rows.filter((r) => r.status_match === "ORFAO_PIPE").reduce((s, r) => s + (r.pipe_valor ?? 0), 0);
  const orfaosVoompValor    = rows.filter((r) => r.status_match === "ORFAO_VOOMP" && !r.voomp_reembolsado).reduce((s, r) => s + (r.voomp_valor_cobrado ?? 0), 0);
  const difPipeVoomp        = totalPipe - totalVoompGerencial;
  // Sentinela de comissão: excesso = soma das divergências líquidas positivas nos casados
  const excessoComissao     = casados.reduce((s, r) => s + Math.max(0, r.divergencia_liquido ?? 0), 0);
  const registroBrutoCount  = rows.filter((r) => r.registro_bruto).length;
  // Taxa da fotografia = bruto cheio − líquido cheio (só não-reembolsados)
  const totalTaxas          = rows.filter((r) => !r.voomp_reembolsado)
    .reduce((s, r) => s + Math.max(0, (r.voomp_valor_bruto ?? r.voomp_valor_cobrado ?? 0) - (r.voomp_valor_cobrado ?? 0)), 0);

  const linksPorCriterio = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of casados) {
      if (r.criterio) m.set(r.criterio, (m.get(r.criterio) ?? 0) + 1);
    }
    return m;
  }, [casados]);

  const snapshotOk = !!fechamento?.snapshot_gerado_em;
  const pipeOk     = pipeCount > 0;
  const cruzou     = casados.length > 0;
  const fechado    = fechamento?.estado === "FECHADO";
  const prontoParaFechar = snapshotOk && pipeOk && cruzou && !fechado;

  const contagens: Record<Filtro, number> = {
    TODOS: rows.length,
    CONCILIADO: casados.length,
    SO_PIPE: orfaosPipeCount,
    SO_VOOMP: orfaosVoompAtivosCount,
    MATERIAL: rows.filter((r) => r.divergencia_classe === "MATERIAL").length,
    REEMBOLSO: reembolsosCount,
    REGISTRO_BRUTO: registroBrutoCount,
  };

  const filtered = useMemo(() => {
    let out = rows;
    if (filtro === "CONCILIADO") out = out.filter((r) => r.status_match === "CASADO");
    else if (filtro === "SO_PIPE") out = out.filter((r) => r.status_match === "ORFAO_PIPE");
    else if (filtro === "SO_VOOMP") out = out.filter((r) => r.status_match === "ORFAO_VOOMP" && !r.voomp_reembolsado);
    else if (filtro === "MATERIAL") out = out.filter((r) => r.divergencia_classe === "MATERIAL");
    else if (filtro === "REEMBOLSO") out = out.filter((r) => r.voomp_reembolsado);
    else if (filtro === "REGISTRO_BRUTO") out = out.filter((r) => r.registro_bruto);

    const q = busca.trim().toLowerCase();
    if (q) {
      out = out.filter((r) =>
        (r.pessoa_nome ?? "").toLowerCase().includes(q) ||
        (r.voomp_aluno_nome ?? "").toLowerCase().includes(q) ||
        (r.pipe_cpf ?? "").includes(q) ||
        (r.voomp_cpf ?? "").includes(q) ||
        (r.voomp_venda_id ?? "").includes(q) ||
        String(r.pipe_deal_id ?? "").includes(q) ||
        (r.produto_nome ?? "").toLowerCase().includes(q)
      );
    }
    return out;
  }, [rows, filtro, busca]);

  const FILTRO_LABEL: Record<Filtro, string> = {
    TODOS: "Todos",
    CONCILIADO: "Conciliados",
    SO_PIPE: "Só no Pipe",
    SO_VOOMP: "Só na Voomp",
    MATERIAL: "Materiais",
    REEMBOLSO: "Reembolsos",
    REGISTRO_BRUTO: "Registro bruto",
  };

  function statusBadge(r: CruzamentoRow) {
    if (r.cross_tenant) {
      const outro = tenantById(r.voomp_tenant_id)?.curto ?? "outro";
      return <Badge variant="destructive" title={`Deal fechado no funil errado — aluno pertence ao tenant ${outro}`}>Outro tenant ({outro})</Badge>;
    }
    if (r.voomp_reembolsado) return <Badge variant="muted">Reembolsado</Badge>;
    if (r.status_match === "CASADO") return <Badge variant="success">Conciliado</Badge>;
    if (r.status_match === "ORFAO_PIPE") return <Badge variant="warning" title="Deal no Pipe sem venda Voomp correspondente">Só no Pipe</Badge>;
    return <Badge variant="warning" title="Venda na Voomp sem deal no Pipe">Só na Voomp</Badge>;
  }

  // ── Etapas do fluxo ──────────────────────────────────────────────

  const etapas = [
    {
      n: 1, titulo: "Importar Pipe", ok: pipeOk,
      detalhe: pipeOk
        ? `${pipeCount} deals${ultimoImport ? ` · ${ultimoImport.nome_arquivo}` : ""}`
        : "Suba o CSV exportado do Pipe",
    },
    {
      n: 2, titulo: "Fotografia Voomp", ok: snapshotOk,
      detalhe: snapshotOk
        ? `${voompCount} vendas · ${new Date(fechamento.snapshot_gerado_em).toLocaleDateString("pt-BR")}`
        : "Capture as vendas do mês",
    },
    {
      n: 3, titulo: "Cruzamento", ok: cruzou,
      detalhe: cruzou
        ? `${casados.length} conciliados (${[...linksPorCriterio.entries()].map(([c, n]) => `${CRITERIO_LABEL[c] ?? c} ${n}`).join(" · ")})`
        : "Case Pipe × Voomp automaticamente",
    },
    {
      n: 4, titulo: "Revisão", ok: cruzou && orfaosPipeCount + orfaosVoompAtivosCount === 0,
      detalhe: cruzou
        ? `${orfaosPipeCount + orfaosVoompAtivosCount} sem par · ${contagens.MATERIAL} materiais`
        : "Aguardando cruzamento",
    },
    {
      n: 5, titulo: "Fechamento", ok: fechado,
      detalhe: fechado
        ? `Fechado em ${fechamento.fechado_em ? new Date(fechamento.fechado_em).toLocaleDateString("pt-BR") : "—"}`
        : "Gera o relatório auditável",
    },
  ];

  return (
    <div className="space-y-6">
      <Link href="/" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4 mr-1" /> Voltar
      </Link>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{mesLabel(ano_mes)}</h1>
          <p className="text-sm text-muted-foreground">{tenant?.nome ?? ""}</p>
        </div>
        {fechamento && (
          <Badge variant={fechado ? "success" : fechamento.estado === "EM_REVISAO" ? "warning" : "muted"}>
            {fechado ? "FECHADO" : fechamento.estado}
          </Badge>
        )}
      </div>

      {/* ── Fluxo em etapas ───────────────────────────────────────── */}
      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            {etapas.map((e) => (
              <div key={e.n} className="flex items-start gap-2">
                <div className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${
                  e.ok ? "bg-green-600 text-white" : "bg-muted text-muted-foreground border border-border"
                }`}>
                  {e.ok ? "✓" : e.n}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium leading-tight">{e.titulo}</p>
                  <p className="text-xs text-muted-foreground leading-tight mt-0.5">{e.detalhe}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {fechado ? (
        /* ── Resultado final (mês fechado) ─────────────────────────── */
        <Card className="border-success/40 bg-success/5">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Lock className="h-4 w-4" /> Resultado final — fechamento auditável
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2 text-sm">
              <div><span className="text-muted-foreground">Deals Pipe:</span> <strong>{fechamento.faturamento_pipe_deals ?? "—"}</strong></div>
              <div><span className="text-muted-foreground">Valor Pipe:</span> <strong>{fechamento.faturamento_pipe_valor != null ? fmtBRL(Number(fechamento.faturamento_pipe_valor)) : "—"}</strong></div>
              <div><span className="text-muted-foreground">Vendas Voomp:</span> <strong>{fechamento.faturamento_voomp_contratos ?? "—"}</strong></div>
              <div><span className="text-muted-foreground">Voomp gerencial:</span> <strong>{fechamento.faturamento_voomp_cobrado != null ? fmtBRL(Number(fechamento.faturamento_voomp_cobrado)) : "—"}</strong></div>
              <div><span className="text-muted-foreground">Reembolsos:</span> <strong>{fechamento.faturamento_voomp_reembolsos != null ? fmtBRL(Number(fechamento.faturamento_voomp_reembolsos)) : "—"}</strong></div>
              <div><span className="text-muted-foreground">Conciliados:</span> <strong>{fechamento.total_matches ?? "—"}</strong></div>
              <div><span className="text-muted-foreground">Só no Pipe:</span> <strong>{fechamento.total_orfaos_pipe ?? "—"}</strong></div>
              <div><span className="text-muted-foreground">Só na Voomp:</span> <strong>{fechamento.total_orfaos_voomp ?? "—"}</strong></div>
            </div>
            {fechamento.hash_relatorio && (
              <p className="text-xs text-muted-foreground font-mono flex items-center gap-1.5">
                <FileCheck className="h-3.5 w-3.5" /> Hash do relatório: {fechamento.hash_relatorio}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Mês somente leitura. Reabertura é feita pelo gestor do banco.
            </p>
          </CardContent>
        </Card>
      ) : (
        /* ── Ações (mês aberto) ────────────────────────────────────── */
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader><CardTitle className="text-base">1. Importar CSV do Pipe</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => { if (e.target.files?.[0]) uploadCsv(e.target.files[0]); e.target.value = ""; }}
              />
              <Button disabled={uploading} className="w-full" variant="outline" onClick={() => fileInputRef.current?.click()}>
                <Upload className="h-4 w-4 mr-2" />{uploading ? "Importando..." : pipeOk ? "Substituir CSV" : "Upload CSV"}
              </Button>
              {ultimoImport ? (
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <p className="flex items-center gap-1">
                    <CheckCircle className="h-3 w-3 text-green-500 shrink-0" />
                    {ultimoImport.linhas_importadas} deals de {ultimoImport.total_linhas_csv} linhas
                  </p>
                  <p className="truncate" title={ultimoImport.nome_arquivo}>{ultimoImport.nome_arquivo}</p>
                  <p className="font-mono" title={ultimoImport.sha256_hash}>
                    {new Date(ultimoImport.imported_at).toLocaleString("pt-BR")} · {ultimoImport.sha256_hash.slice(0, 10)}…
                  </p>
                </div>
              ) : pipeOk ? (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <CheckCircle className="h-3 w-3 text-green-500" /> {pipeCount} deals carregados
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Substitui todos os deals do mês (full replace).</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">2. Fotografia Voomp</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {snapshotOk ? (
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <p className="text-sm flex items-center gap-2 text-green-600">
                    <CheckCircle className="h-4 w-4" /> Capturada em {new Date(fechamento.snapshot_gerado_em).toLocaleString("pt-BR")}
                  </p>
                  <p>{voompCount} vendas do mês · imutável</p>
                </div>
              ) : (
                <>
                  <Button onClick={gerarSnapshotVoomp} disabled={gerandoSnapshot} className="w-full" variant="outline">
                    <Camera className="h-4 w-4 mr-2" />{gerandoSnapshot ? "Capturando..." : "Capturar vendas do mês"}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Congela as vendas Voomp pagas no mês. Ação imutável.
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">3. Cruzar e fechar</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <Button onClick={rodarCruzamento} disabled={running || !snapshotOk || !pipeOk} className="w-full">
                <Play className="h-4 w-4 mr-2" />{running ? "Cruzando..." : "Rodar cruzamento"}
              </Button>
              <Button onClick={exportarFechar} disabled={exporting || !prontoParaFechar} className="w-full" variant="success">
                <Download className="h-4 w-4 mr-2" />{exporting ? "Gerando..." : "Fechar mês + relatório"}
              </Button>
              {!fechado && !prontoParaFechar && (
                <p className="text-xs text-warning">
                  {!pipeOk ? "Importe o CSV do Pipe. " : ""}
                  {!snapshotOk ? "Capture a fotografia Voomp. " : ""}
                  {pipeOk && snapshotOk && !cruzou ? "Rode o cruzamento." : ""}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Resumo financeiro ─────────────────────────────────────── */}
      {!loading && rows.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-4">
          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">Pipe (comercial)</CardTitle></CardHeader>
            <CardContent>
              <p className="text-lg font-semibold tabular-nums">{fmtBRL(totalPipe)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{pipeCount} deals</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">Voomp (fiscal)</CardTitle></CardHeader>
            <CardContent>
              <p className="text-lg font-semibold tabular-nums">{fmtBRL(totalVoompGerencial)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {voompCount - reembolsosCount} vendas · líquido{totalTaxas > 0 ? ` · taxas ${fmtBRL(totalTaxas)}` : ""}
              </p>
            </CardContent>
          </Card>

          <Card className={Math.abs(difPipeVoomp) > 1000 ? "border-warning/50 bg-warning/5" : ""}>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">Diferença</CardTitle></CardHeader>
            <CardContent>
              <p className="text-lg font-semibold tabular-nums">{fmtBRL(difPipeVoomp)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {totalPipe !== 0 ? `${((Math.abs(difPipeVoomp) / totalPipe) * 100).toFixed(1)}% do Pipe` : "—"}
              </p>
            </CardContent>
          </Card>

          <Card className={totalReembolsos > 0 ? "border-destructive/40 bg-destructive/5" : ""}>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">Reembolsos</CardTitle></CardHeader>
            <CardContent>
              <p className={`text-lg font-semibold tabular-nums ${totalReembolsos > 0 ? "text-destructive" : ""}`}>
                {totalReembolsos > 0 ? `- ${fmtBRL(totalReembolsos)}` : fmtBRL(0)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">{reembolsosCount} venda{reembolsosCount !== 1 ? "s" : ""}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">Conciliado</CardTitle></CardHeader>
            <CardContent>
              <p className="text-lg font-semibold tabular-nums">{fmtBRL(casadosPipe)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{casados.length} pares · Voomp {fmtBRL(casadosVoomp)}</p>
            </CardContent>
          </Card>

          <Card className={orfaosPipeValor + orfaosVoompValor > 0 ? "border-warning/50 bg-warning/5" : ""}>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">Sem par</CardTitle></CardHeader>
            <CardContent>
              <p className="text-lg font-semibold tabular-nums">{fmtBRL(orfaosPipeValor + orfaosVoompValor)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Pipe {fmtBRL(orfaosPipeValor)} · Voomp {fmtBRL(orfaosVoompValor)}</p>
            </CardContent>
          </Card>

          {/* Sentinela: comercial deve registrar pelo líquido — esperado R$0 / 0 deals */}
          <Card className={registroBrutoCount > 0 ? "border-destructive/40 bg-destructive/5" : ""}>
            <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">Base de comissão</CardTitle></CardHeader>
            <CardContent>
              <p className={`text-lg font-semibold tabular-nums ${excessoComissao > 0 ? "text-destructive" : ""}`}>
                {excessoComissao > 0 ? `+ ${fmtBRL(excessoComissao)}` : fmtBRL(0)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {registroBrutoCount === 0 ? "0 registros em bruto ✓" : `${registroBrutoCount} deal(s) em bruto — ajustar no Pipe`}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Suspeitos de tenant errado ────────────────────────────── */}
      {suspeitos.length > 0 && !fechado && (
        <Card className="border-warning/50 bg-warning/5">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2 text-warning">
              <ShieldAlert className="h-4 w-4" />
              {suspeitos.length} deal{suspeitos.length > 1 ? "s" : ""} possivelmente no funil errado
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Deals sem par neste tenant que batem por CPF ou e-mail com vendas sem par no outro tenant.
              Vincular registra o erro de funil — aparece como “Outro tenant” no resultado e no relatório.
            </p>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left border-b border-border">
                  <tr>
                    <th className="py-2 pr-4">Deal</th>
                    <th className="py-2 pr-4">Nome no Pipe</th>
                    <th className="py-2 pr-4">Aluno na Voomp</th>
                    <th className="py-2 pr-4">Tenant Voomp</th>
                    <th className="py-2 pr-4 text-right">Pipe</th>
                    <th className="py-2 pr-4 text-right">Voomp</th>
                    <th className="py-2 pr-4">Bate por</th>
                    <th className="py-2 pr-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {suspeitos.map((s) => (
                    <tr key={`${s.pipe_deal_id}-${s.snapshot_id}`} className="border-b border-border/50">
                      <td className="py-2 pr-4 font-mono text-xs">{s.pipe_deal_id}</td>
                      <td className="py-2 pr-4 max-w-[160px] truncate" title={s.pipe_nome ?? ""}>{s.pipe_nome ?? "—"}</td>
                      <td className="py-2 pr-4 max-w-[160px] truncate" title={s.voomp_nome ?? ""}>{s.voomp_nome ?? "—"}</td>
                      <td className="py-2 pr-4"><Badge variant="warning">{tenantById(s.tenant_voomp)?.curto ?? "?"}</Badge></td>
                      <td className="py-2 pr-4 text-right tabular-nums">{fmtBRL(Number(s.pipe_valor))}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{fmtBRL(Number(s.voomp_valor))}</td>
                      <td className="py-2 pr-4"><Badge variant="muted">{s.criterio_suspeita}</Badge></td>
                      <td className="py-2 pr-4">
                        <Button size="sm" variant="outline" disabled={linkingCross === s.pipe_deal_id} onClick={() => vincularCrossTenant(s)}>
                          {linkingCross === s.pipe_deal_id ? "Vinculando..." : "Vincular"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Resultado ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <CardTitle>Resultado ({filtered.length} de {rows.length})</CardTitle>
            <div className="flex flex-col gap-2 md:flex-row md:items-center">
              <div className="relative">
                <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Buscar nome, CPF, venda, deal..."
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  className="h-9 pl-8 pr-3 rounded-md border border-border text-sm w-full md:w-64"
                />
              </div>
              <div className="flex gap-1 text-xs flex-wrap">
                {(Object.keys(FILTRO_LABEL) as Filtro[]).map((f) => (
                  <Button key={f} variant={filtro === f ? "default" : "outline"} size="sm" onClick={() => setFiltro(f)}>
                    {FILTRO_LABEL[f]} ({contagens[f]})
                  </Button>
                ))}
              </div>
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
                    <th className="py-2 pr-4">Situação</th>
                    <th className="py-2 pr-4">Cliente (Pipe)</th>
                    <th className="py-2 pr-4">Aluno (Voomp)</th>
                    <th className="py-2 pr-4 text-right">Pipe</th>
                    <th className="py-2 pr-4 text-right">Voomp</th>
                    <th className="py-2 pr-4 text-right">Diferença</th>
                    <th className="py-2 pr-4">Casou por</th>
                    <th className="py-2 pr-4">Avaliação</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r, idx) => (
                    <tr key={idx} className={`border-b border-border/50 ${r.voomp_reembolsado ? "opacity-60" : ""}`}>
                      <td className="py-2 pr-4">{statusBadge(r)}</td>
                      <td className="py-2 pr-4 max-w-[180px]">
                        <div className="truncate" title={r.pessoa_nome ?? ""}>{r.pessoa_nome ?? "—"}</div>
                        {r.pipe_deal_id && (
                          <div className="text-xs text-muted-foreground font-mono">deal {r.pipe_deal_id}</div>
                        )}
                      </td>
                      <td className="py-2 pr-4 max-w-[200px]">
                        <div className="truncate" title={r.voomp_aluno_nome ?? ""}>{r.voomp_aluno_nome ?? "—"}</div>
                        {r.voomp_venda_id && (
                          <div className="text-xs text-muted-foreground font-mono">
                            venda {r.voomp_venda_id}
                            {r.voomp_contrato_id ? ` · contrato ${r.voomp_contrato_id}` : ""}
                          </div>
                        )}
                        {(r.qtd_cobrancas ?? 1) > 1 && (
                          <Badge variant="muted" title={`Pagamento dividido — vendas: ${(r.vendas_agrupadas ?? []).join(", ")}`}>
                            {r.qtd_cobrancas} cobranças
                          </Badge>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{r.pipe_valor != null ? fmtBRL(Number(r.pipe_valor)) : "—"}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{r.voomp_valor_cobrado != null ? fmtBRL(Number(r.voomp_valor_cobrado)) : "—"}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{r.divergencia_valor != null ? fmtBRL(Number(r.divergencia_valor)) : "—"}</td>
                      <td className="py-2 pr-4">
                        {r.criterio ? `${CRITERIO_LABEL[r.criterio] ?? r.criterio}${r.confianca ? ` (${r.confianca}%)` : ""}` : "—"}
                      </td>
                      <td className="py-2 pr-4">
                        <div className="flex flex-wrap gap-1">
                          {r.divergencia_classe && (
                            <Badge variant={CLASSE_VARIANT[r.divergencia_classe] ?? "muted"}>
                              {CLASSE_LABEL[r.divergencia_classe] ?? r.divergencia_classe}
                            </Badge>
                          )}
                          {r.registro_bruto && (
                            <Badge variant="destructive" title="Deal registrado pelo valor bruto — comissão deve ser sobre o líquido; ajustar no Pipe">
                              Registro bruto
                            </Badge>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-muted-foreground">
                        Nenhum registro {busca ? `para "${busca}"` : "neste filtro"}.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {!fechado && (
        <div className="flex justify-end">
          <Link href={`/mes/${ano_mes}/conciliacao`}>
            <Button variant="outline"><AlertCircle className="h-4 w-4 mr-2" />Vincular manualmente os sem par</Button>
          </Link>
        </div>
      )}
    </div>
  );
}
