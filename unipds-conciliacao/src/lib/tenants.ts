// Mapa estático tenant_id -> nome legível e funil correspondente no Pipe
// Em produção isso poderia vir do banco, mas como são 2 e estáveis, mantém-se aqui.

export type Tenant = {
  id: string;
  nome: string;
  funilPipe: string; // Como aparece no CSV exportado do Pipe
  curto: string;
};

export const TENANTS: Tenant[] = [
  {
    id: "e717e24d-fb30-4ed0-83d3-bb8ea0b66783",
    nome: "UNIPDS INTELIGENCIA ARTIFICIAL",
    funilPipe: "UNIPDS - IA",
    curto: "IA",
  },
  {
    id: "70b668e4-be85-459b-8dbb-3876929ac850",
    nome: "UNIPDS POS GRADUACAO JAVA ELITE",
    funilPipe: "UNIPDS - Java",
    curto: "Java",
  },
];

export function tenantById(id: string | null | undefined): Tenant | null {
  if (!id) return null;
  return TENANTS.find((t) => t.id === id) ?? null;
}

export function tenantByFunil(funil: string): Tenant | null {
  return TENANTS.find((t) => t.funilPipe === funil) ?? null;
}
