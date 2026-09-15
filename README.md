# Elloot API

API do marketplace [Elloot](https://github.com/elloot-hub/elloot-api) — Express 5, Prisma 6, PostgreSQL, Redis opcional.

Frontend irmão: [`elloot-app`](https://github.com/elloot-hub/elloot-app).

## Requisitos

- Node.js 20+
- PostgreSQL 15+
- Redis (opcional)

## Setup

```bash
git clone https://github.com/elloot-hub/elloot-api.git
cd elloot-api
npm install
cp .env.example .env.local
# Ajuste DATABASE_URL, JWT_SECRET, PORT, FRONTEND_URL, CORS_ORIGIN

npx prisma generate
npx prisma db push
npx prisma db seed           # categorias (+ seções)
npm run db:secure            # RLS
npm run dev                  # http://localhost:5000 (ou PORT do .env)
```

Health: `GET /api/health`

Com Docker local (Postgres):

```bash
docker compose up -d
```

## Scripts

| Comando | Uso |
|---------|-----|
| `npm run dev` | API com nodemon |
| `npm run typecheck` | TypeScript |
| `npm run test:e2e` | Fluxo E2E (API no ar) |
| `npm run db:studio` | Prisma Studio |
| `npm run db:secure` | Aplica policies RLS |

## Estrutura

```
src/
  config/          # env, SSL
  databases/       # Prisma, Redis, RLS
  lib/             # errors, async-handler, sanitize
  middleware/      # auth, errors, rls
  modules/         # domínio (um por pasta)
  routes/index.ts  # monta /api/*
prisma/
  schema.prisma
  seed.ts
  data/            # categorias GGMAX + seções
  sql/             # RLS
scripts/           # e2e-flow.ts
```

## Módulos

| Módulo | Prefixo |
|--------|---------|
| health | `/api/health` |
| auth | `/api/auth` |
| catalog | `/api/catalog` |
| listings | `/api/listings` |
| media | `/api/media` |
| orders | `/api/orders` |
| payments | `/api/payments` |
| wallet | `/api/wallet` |
| conversations | `/api/conversations` |
| disputes | `/api/disputes` |
| jobs | `/api/jobs` |

Detalhes de env: [`.env.example`](./.env.example) (dev) e [`.env.production.example`](./.env.production.example) (prod).

## Deploy (Square Cloud + GitHub Actions)

O build roda no **GitHub Actions**; a Square recebe o zip já compilado (`commit --file … --restart`).

Docs: [Next.js na Square](https://docs.squarecloud.app/pt-br/tutorials/website/nextjs) · [Workflow / Actions](https://help.squarecloud.app/pt-br/article/workflow-github-actions-deploy-automatico-o6c7e2/) · [Integração GitHub](https://help.squarecloud.app/pt-br/article/como-integrar-seu-repositorio-do-github-e-fazer-deploy-automatico-1nk6gr9/)

### 1. App na Square (uma vez)

1. Crie a aplicação web no painel (ou faça o primeiro upload).
2. Copie o **Application ID**.
3. Em **Minha conta → API**, gere o **token**.
4. Preencha as variáveis do [`.env.production.example`](./.env.production.example) em **Variáveis de Ambiente**.
5. Coloque certificados Postgres/EFI nos arquivos da app (nunca no Git).

### 2. Secrets no GitHub (`Settings → Secrets and variables → Actions`)

| Secret | Onde pegar |
|--------|------------|
| `SQUARE_CLOUD_TOKEN` | Dashboard Square → API token |
| `SQUARECLOUD_APP_ID` | ID da aplicação na Square |

### 3. Deploy

- Push em `main` / `master`, ou
- Actions → **Deploy Square Cloud** → **Run workflow**

Workflow: [`.github/workflows/deploy-squarecloud.yml`](./.github/workflows/deploy-squarecloud.yml)

No banco novo (uma vez, local apontando para prod + SSL):

```bash
npx prisma db push
npm run db:secure
npx prisma db seed
```

Health: `GET https://www.api.elloot.com.br/api/health`

Fronts usam o mesmo padrão de Actions (build no GitHub → commit na Square).


## Segurança

- Não commitar `.env`, certificados TLS nem arquivos em `storage/`.
- JWT e secrets só via variáveis de ambiente.

## Licença

Privado / uso do time Elloot.
