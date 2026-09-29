# Deploying GrantDesk on Lovable

Local development keeps the Docker Supabase + Ollama stack. On Lovable there is
no Docker and no Ollama, so the app runs on Lovable Cloud (hosted Supabase),
the cloud LLM chain, and a hosted embedder.

## 1. Connect the repo

In Lovable: **Settings → GitHub → Connect**, pick `rafaelcastro7/grantdesk`,
branch `main`. Enable **Lovable Cloud** for the project.

## 2. Secrets (Cloud → Secrets)

| Secret                                                     | Why                                                                     |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| `SUPABASE_SERVICE_ROLE_KEY`                                | catalog writer, importers, scheduled jobs                               |
| `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `GOOGLE_AI_STUDIO_KEY` | LLM chain (a missing key is skipped)                                    |
| `EMBED_API_URL`, `EMBED_API_KEY`                           | hosted embeddings, e.g. DeepInfra `https://api.deepinfra.com/v1/openai` |
| `RESEND_API_KEY`, `EMAIL_FROM`                             | outbound email                                                          |

`VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` are provided by Lovable.
Do **not** set `OLLAMA_BASE_URL`: without it the chain ends at the last cloud
provider and `doctor` reports the local floor as "degraded", by design.

The embedder must serve the same models as the stored vectors (BAAI/bge-m3,
nomic-embed-text v1.5). Another model makes search compare incompatible
vectors and return confident nonsense.

## 3. Database

Apply `supabase/migrations/*.sql` in filename order in the Cloud SQL editor
(`0000_extensions.sql` first). Every file is idempotent against a fresh
project; `0032` skips the local-only `schema_migrations` table.

Then load the catalog once from a machine with the repo:
`SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… EMBED_API_URL=… bun run refresh && bun run embed`.

## 4. Scheduled jobs

Lovable has no cron. Run `bun run refresh` hourly (catalog + embeddings) and the
email outbox sender from an external scheduler — GitHub Actions `schedule:` with
the secrets above, or the existing Windows task pointed at the Cloud URL.

## 5. Check

`bun run doctor` with the Cloud env: everything `ok` except `local floor`.
