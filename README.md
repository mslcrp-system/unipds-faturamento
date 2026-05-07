# Unipds — Conciliação Pipe ↔ Voomp

Sistema de fechamento mensal auditável de novos alunos. Cruza dados do CRM Pipedrive com a plataforma Voomp via Supabase.

## Stack

- Next.js 14 (App Router) + TypeScript
- Supabase Auth (magic-link) + RLS
- Tailwind CSS + shadcn/ui
- exceljs (server-side XLSX + hash SHA256)
- papaparse (parse CSV client-side)

## Setup local

```bash
# 1. Instalar dependências
npm install

# 2. Variáveis de ambiente
cp .env.example .env.local
# Preencher NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_ANON_KEY

# 3. Rodar
npm run dev
```

Acessar: http://localhost:3000

## Deploy Vercel

```bash
# 1. Instalar CLI
npm i -g vercel

# 2. Login
vercel login

# 3. Deploy
vercel

# 4. Configurar env vars no painel do Vercel
#    NEXT_PUBLIC_SUPABASE_URL
#    NEXT_PUBLIC_SUPABASE_ANON_KEY
```

## Configuração Supabase

### 1. Criar usuário no Auth do Supabase

No painel Supabase → Authentication → Users → Add user → criar com seu email.

### 2. Adicionar `tenant_id` ao user_metadata

Após criar o usuário, edite e adicione no user_metadata:

```json
{
  "tenant_id": "e717e24d-fb30-4ed0-83d3-bb8ea0b66783"
}
```

(Use o tenant_id de IA ou Java. O frontend permite alternar.)

### 3. Permitir RPC executar_cruzamento

Conceder execução para o role authenticated:

```sql
GRANT EXECUTE ON FUNCTION unipds.executar_cruzamento(uuid, text) TO authenticated;
```

### 4. Garantir SELECT/INSERT/UPDATE nas tabelas via RLS

As policies já existem (`tenant_isolation` em cada tabela do schema unipds).

## Fluxo operacional mensal

1. Login com magic-link
2. Dashboard mostra os meses; criar fechamento do mês
3. Confirmar ingestão Voomp (botão na tela do mês)
4. Upload do CSV exportado do Pipedrive
5. Rodar cruzamento (chama `unipds.executar_cruzamento`)
6. Revisar matches e classificações de divergência
7. Resolver órfãos via tela de conciliação manual
8. Exportar XLSX → API gera hash SHA256 → fechamento muda para FECHADO

## Auditabilidade Definição 2

- Hash SHA256 do XLSX é gravado em `fechamentos_mensais.hash_relatorio`
- Estado FECHADO é imutável (Fase 4 implementará trigger)
- Ingestão deve estar `COMPLETA` em todas as fontes ativas antes de fechar (trigger já ativo)

## Estrutura

```
src/
├── app/
│   ├── login/             # Magic-link
│   ├── (auth)/            # Telas autenticadas
│   │   ├── page.tsx       # Dashboard
│   │   └── mes/[ano_mes]/
│   │       ├── page.tsx   # Detalhe + upload + cruzamento
│   │       └── conciliacao/page.tsx
│   └── api/
│       └── export/[ano_mes]/route.ts  # XLSX + hash
├── lib/
│   ├── supabase/          # Clientes server e browser
│   ├── csv-parser.ts      # Normalização Pipe
│   └── tenants.ts         # Mapa tenant_id → nome
└── components/
    └── ui/                # shadcn primitives mínimos
```
