# Supabase Remote Connection Runbook

## 1. Prepare local secrets

```bash
cp .env.supabase.local.example .env.supabase.local
```

Fill required values in `.env.supabase.local`:

- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_PROJECT_REF`
- `SUPABASE_DB_PASSWORD`

## 2. Load env vars

```bash
set -a
source .env.supabase.local
set +a
```

## 3. Authenticate CLI

```bash
npx --yes supabase login --token "$SUPABASE_ACCESS_TOKEN"
```

## 4. Link repository to remote project

```bash
npx --yes supabase link --project-ref "$SUPABASE_PROJECT_REF" --password "$SUPABASE_DB_PASSWORD"
```

## 5. Verify connection

```bash
npx --yes supabase status
npx --yes supabase db pull --linked --password "$SUPABASE_DB_PASSWORD"
```

The `db pull` command should create a migration file with the remote schema snapshot.
