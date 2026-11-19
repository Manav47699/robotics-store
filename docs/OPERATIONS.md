# Operations guide

Everything needed to run, maintain, back up and recover the store. Written so a future committee can take over without help.

## How it fits together

```
Browser ──► Vercel (index.html, js/, assets/, vendor/)        ← deploys automatically on push to main
   │
   └────► Supabase (Tokyo)  Postgres + Auth + Realtime        ← all data lives here
              ▲
              ├── GitHub Actions "Nightly backup" (00:00 and 12:00 NPT)
              │     ├─► private repo robotics-store-backup   (SQL + CSV + Excel, every run in git history)
              │     │     └─► copied to the maintainer's computer twice a day (scripts/local-mirror.sh)
              │     └─► encrypted artifact (90 days)
              ├── GitHub Actions "Keep-alive & backup watchdog" (09:08 and 18:38 NPT)
              └── Vercel Cron → api/keepalive.js (daily)
```

### Why the database never goes to sleep

Free Supabase projects **pause after 7 days without database activity**. Three independent things query the database every day:

1. each backup run (twice a day): a full dump, plus `scripts/keepalive.sh`
2. the *Keep-alive & backup watchdog* workflow (twice a day): `scripts/keepalive.sh`
3. Vercel Cron calling `/api/keepalive` (daily), which keeps working even if GitHub Actions is down

Every keep-alive is a real **write**: it calls `public.keepalive_ping()` (migration `0003_keepalive`), which inserts a row into the hidden `keepalive_heartbeat` table and deletes the previous one. The table always has exactly one row, showing when the last ping happened and where it came from. The site never reads it, logged-out users can't see it, and it is not in the audit log or realtime.

Before Nov 2026 the only "keep-alive" was an Auth health ping, which does not touch the database. The project paused on ~13 Nov 2026 as a result.

### Why a missed backup can't go unnoticed

- The watchdog fails if the newest backup is more than 26 hours old, **and starts a new backup by itself** if the database is up.
- Any failure → GitHub email + one issue (*Backup is failing* / *Database or backups need attention*), with a comment for each repeat.
- The local copy (`scripts/install-local-mirror.sh`) shows a desktop alert if the backups are more than 2 days old.

| Thing | Where |
|---|---|
| Live site | https://robotics-store-management.vercel.app |
| Database dashboard | https://supabase.com/dashboard/project/dnvluspfcebqvulrdqoi |
| Backups | https://github.com/Manav47699/robotics-store-backup (private) |
| Backup runs | main repo → **Actions** → *Nightly backup* and *Keep-alive & backup watchdog* |
| Local backup copy | `~/robotics-store-backups` on the maintainer's computer (install: `scripts/install-local-mirror.sh`) |

## How the data is protected

- **Login required for everything.** Logged-out visitors (and any account that isn't in the `staff` table) can't read or change anything — enforced by the database (row-level security), not just the page.
- **Stock can never go negative.** The database checks every issue/restore and locks the component row, so two people issuing the last unit at the same moment can't both succeed.
- **Double-clicks and network retries are recorded once** (each form submit carries a unique request id).
- **Move to bin** hides things and can be undone for 60 days. After 60 days in the bin they are **deleted automatically** (`purge_bin()`, migration `0004`, run by every keep-alive ping). **Delete permanently** removes them from the site straight away. Either way, every change — including deletions — is copied to `audit_log`, which nobody can edit, and into the nightly backups.
- **Backups twice a day** are restore-tested before being saved. If a backup fails, GitHub emails the repo owner and opens an issue in this repo.
- **Offline:** if the internet drops, the site shows the last loaded data read-only and recovers automatically.

## Local setup (for maintainers)

```bash
git clone git@github.com:Manav47699/robotics-store-management.git
cd robotics-store-management
cp .env.example .env        # fill in values from Supabase → Project Settings
git config core.hooksPath .githooks   # blocks commits that contain secrets
python3 -m http.server 8765           # open http://localhost:8765
```

`.env` is git-ignored and must never be committed. The pre-commit hook and the *Checks* workflow both scan for secrets.

## Common tasks

| Task | How |
|---|---|
| Change the site login password | Put the new password in `.env` as `APP_LOGIN_PASSWORD`, run `scripts/create-login.sh`. Everyone is logged out. |
| Change a style/class in the HTML/JS | Edit, then `scripts/build-css.sh` and commit `assets/app.css` too. |
| Change the database (new field etc.) | Add `supabase/migrations/000N_name.sql` (copy the pattern: `begin; … insert into public.app_migrations … commit;`), run `scripts/migrate.sh`. Also update `scripts/backup.sh` CSV queries if the field should appear in the readable exports. |
| Check the database is awake | `scripts/keepalive.sh` |
| Run a backup by hand | GitHub → Actions → *Nightly backup* → **Run workflow**. Or locally: `scripts/backup.sh` (needs `pg_dump` 17). |
| Check everything works | `python3 tests/api_test.py` (database rules, 36 checks) and `tests/e2e.cjs` (full browser test, see header of the file). Both clean up after themselves. |
| Recover a permanently-deleted row | It's in `audit_log` (`old_row` column) in Supabase → Table editor, and in the backups. |

## GitHub secrets (main repo → Settings → Secrets and variables → Actions)

| Secret | Value |
|---|---|
| `SUPABASE_DB_URL` | Supabase → **Connect** → *Session pooler* URI, with the database password filled in. (Not the *Direct* one — GitHub can't reach it.) |
| `BACKUP_DEPLOY_KEY` | Private half of an SSH key whose public half is a **write** deploy key on `robotics-store-backup`. Kept locally in `secrets/backup_deploy_key` (git-ignored). |
| `BACKUP_ENCRYPTION_PASSPHRASE` | Long random passphrase for the encrypted artifact. Also keep it in `.env` and a password manager. |

## Rotating credentials

Do this whenever someone with access leaves the committee, or if a secret may have leaked.

1. **Database password:** Supabase → Project Settings → Database → *Reset database password*. Update `SUPABASE_DB_URL` in `.env` **and** the GitHub secret. Run the backup workflow by hand to confirm.
2. **Secret API key:** Supabase → Project Settings → API Keys → create a new secret key, delete the old one. Update `.env`.
3. **Site password:** see *Common tasks*.
4. **Deploy key:** `ssh-keygen -t ed25519 -N "" -f key`; replace the deploy key on the backup repo and the `BACKUP_DEPLOY_KEY` secret; delete both key files.

The publishable key in `js/config.js` is public by design and doesn't need rotating.

## Disaster recovery

**The site is down / Supabase project is gone / data was damaged.**

0. **Project only paused?** Supabase dashboard → open the project → **Restore project**. Paused free projects can be restored for 90 days; no data is lost. Then run *Nightly backup* by hand.
1. Get a backup folder: use `~/robotics-store-backups/latest/` on the maintainer's computer, or clone `robotics-store-backup` and use `latest/` (or any older commit / `monthly/` folder from before the damage).
   If GitHub itself is unavailable: download the newest *robostore-backup-encrypted-N* artifact from an Actions run and decrypt it:
   `gpg --decrypt robostore-backup.tar.gz.gpg | tar -xz -C backup-folder` (asks for the passphrase).
2. If the old Supabase project still exists and only data is damaged, you can restore into it. Otherwise create a **new** Supabase project.
3. Install the PostgreSQL 17 client (`postgresql-client-17`), then:
   ```bash
   scripts/restore.sh backup-folder "postgresql://postgres.NEWREF:[YOUR-PASSWORD]@aws-0-REGION.pooler.supabase.com:5432/postgres"
   ```
   It asks you to type `RESTORE`, saves a safety copy of whatever was there first, then restores.
4. New project only: put the new URL/keys in `.env`, run `scripts/create-login.sh`, update `js/config.js` (URL + publishable key) **and the URLs in `vercel.json` and `index.html` (Content-Security-Policy)**, commit and push. Update the `SUPABASE_DB_URL` GitHub secret.
5. Open the site, log in, check the numbers match `manifest.json`.

## Free-tier limits to keep in mind

- Supabase free: 500 MB database (this app uses well under 1 MB per thousand records), projects pause after 7 days of no database activity — three daily keep-alives prevent this (see above). Free projects have no point-in-time recovery: at most ~12 hours of changes can be lost (time since the last backup).
- GitHub disables scheduled workflows after 60 days without repo activity — both workflows re-enable each other on every run.
- If a backup fails or the database is unreachable, you'll get an email and a GitHub issue. Don't ignore it.
