# RC Store Ledger

Inventory and issue ledger for the 11th Committee Robotics Club store.

**Live:** https://robotics-store-management.vercel.app

- **Stock List**: every component with total, available and on-loan units
- **Issue Logs**: who borrowed what (name, roll number, date) and when it came back
- **Bin**: removed items, restorable for 60 days, then deleted automatically
- Changes show up on every open device instantly. Excel/JSON export from the menu.

Static site on Vercel, Supabase (Postgres) for data and login. The database is backed up twice a day to a private repo, and every backup is restore-tested before it is saved.

Setup, maintenance, credentials and disaster recovery: [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Maintenance notes

Backups and the keep-alive run on their own. What can break them:

- **Failure emails / "Backup is failing" issues.** These are the only alert. Check the failed run under **Actions**.
- **Database password.** If it's changed in Supabase, update the `SUPABASE_DB_URL` secret too, then run *Nightly backup* by hand.
- **Backup repo.** `robotics-store-backup` must stay private and keep its deploy key. If it's renamed, update the name in `.github/workflows/backup.yml` and `scripts/`.
- **`js/config.js`.** The site and the Vercel keep-alive both read the Supabase URL and key from it.
- **Schema changes.** Make them as a migration in `supabase/migrations/` (run `scripts/migrate.sh`), not in the Supabase dashboard, or a restore won't recreate them.

Free-tier limits:

- **Supabase:** 500 MB database and 5 GB egress a month, far more than this app uses. Free projects pause after 7 days with no database activity. The keep-alive prevents that. If it does pause, use **Restore project** in the dashboard; no data is lost.
- **GitHub Actions:** a few minutes per backup run. Scheduled workflows are disabled after 60 days without repo activity; these workflows re-enable each other.
- **Vercel:** one cron job a day (the keep-alive).

Healthy means green *Nightly backup* runs twice a day under **Actions**, and today's date in `latest/manifest.json` in the backup repo.
