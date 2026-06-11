import Papa from "papaparse";
import { tenantByFunil } from "./tenants";

export type PipeDealRow = {
  pipe_deal_id: number;
  tenant_id: string;
  pessoa_id: number | null;
  titulo: string;
  valor: number;
  funil: string;
  status: string;
  ganho_em: string | null;
  proprietario: string | null;
  cpf_raw: string | null;
  cpf_clean: string | null;
  email_raw: string | null;
  email_clean: string | null;
  rg: string | null;
  telefone_raw: string | null;
  telefone_clean: string | null;
  pessoa_nome: string | null;
  pessoa_nome_norm: string | null;
  ano_mes: string;
};

function limpaCpf(v: unknown): string | null {
  if (v == null) return null;
  const d = String(v).replace(/\D/g, "");
  if (d.length < 11) return null;
  if (/^(\d)\1+$/.test(d)) return null;
  return d.padStart(11, "0").slice(-11);
}

function limpaEmail(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).toLowerCase().trim();
  return s || null;
}

function limpaTelefone(v: unknown): string | null {
  if (v == null) return null;
  const d = String(v).replace(/\D/g, "");
  if (d.length < 10) return null;
  return d.length >= 11 ? d.slice(-11) : d;
}

function normalizaNome(v: unknown): string | null {
  if (v == null) return null;
  let s = String(v).toLowerCase().trim();
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  s = s.replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  return s || null;
}

function parseDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  return String(v);
}

function anoMesFrom(dt: string | null): string | null {
  if (!dt) return null;
  return dt.slice(0, 7);
}

export function parsePipeCsv(content: string): {
  rows: PipeDealRow[];
  errors: string[];
  unknownFunils: Set<string>;
  totalLinhas: number;
} {
  const result = Papa.parse<Record<string, string>>(content, { header: true, skipEmptyLines: true });
  const rows: PipeDealRow[] = [];
  const errors: string[] = [];
  const unknownFunils = new Set<string>();
  const totalLinhas = result.data.length;

  for (const r of result.data) {
    const funil = (r["Negócio - Funil"] || "").trim();
    const tenant = tenantByFunil(funil);
    if (!tenant) {
      unknownFunils.add(funil);
      continue;
    }
    const dealIdRaw = r["Negócio - ID"];
    const valorRaw = r["Negócio - Valor do negócio"];
    if (!dealIdRaw || !valorRaw) {
      errors.push(`Linha ignorada: ID ou valor ausente`);
      continue;
    }
    const ganhoEm = parseDate(r["Negócio - Ganho em"]);
    const ano_mes = anoMesFrom(ganhoEm);
    if (!ano_mes) {
      errors.push(`Deal ${dealIdRaw} sem data de ganho`);
      continue;
    }

    rows.push({
      pipe_deal_id: parseInt(dealIdRaw, 10),
      tenant_id: tenant.id,
      pessoa_id: r["Pessoa - ID"] ? parseInt(r["Pessoa - ID"], 10) : null,
      titulo: r["Negócio - Título"] || "",
      valor: parseFloat(valorRaw),
      funil,
      status: r["Negócio - Status"] || "",
      ganho_em: ganhoEm,
      proprietario: r["Negócio - Proprietário"] || null,
      cpf_raw: r["Pessoa - CPF"] || null,
      cpf_clean: limpaCpf(r["Pessoa - CPF"]),
      email_raw: r["Pessoa - E-mail"] || null,
      email_clean: limpaEmail(r["Pessoa - E-mail"]),
      rg: r["Pessoa - RG"] || null,
      telefone_raw: r["Pessoa - Telefone"] || null,
      telefone_clean: limpaTelefone(r["Pessoa - Telefone"]),
      pessoa_nome: r["Pessoa - Nome"] || null,
      pessoa_nome_norm: normalizaNome(r["Pessoa - Nome"]),
      ano_mes,
    });
  }
  return { rows, errors, unknownFunils, totalLinhas };
}
