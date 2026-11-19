# RC Store Ledger

Inventory and issue ledger for the 11th Committee Robotics Club store.

**Live:** https://robotics-store-management.vercel.app

- **Stock List** — every component with total, available and on-loan units
- **Issue Logs** — who borrowed what (name, roll number, date) and when it came back
- **Bin** — things moved to the bin, restorable or permanently deletable
- Changes appear on every open device instantly; Excel/JSON export from the menu

Built as a static site on Vercel with Supabase (Postgres) for data and login. Backed up twice a day to a private repo (each backup restore-tested), with a watchdog that keeps the database awake and re-runs missed backups.

See **[docs/OPERATIONS.md](docs/OPERATIONS.md)** for setup, maintenance, credentials and disaster recovery.

## Things that can break it

The backups and keep-alive run by themselves. These are the only things that can stop them:

| Don't… | Because | If you have to |
|---|---|---|
| Ignore a "Backup is failing" email or GitHub issue | That's the only warning you get. | Open the failed run under **Actions** and read the red step. |
| Change the Supabase database password without telling GitHub | The backup logs in with it. | Update the `SUPABASE_DB_URL` secret, then run *Nightly backup* by hand. |
| Delete, rename or make public `robotics-store-backup`, or remove its deploy key | The backups are pushed there with that key. | Renaming it means changing its name in `.github/workflows/backup.yml` and `scripts/`. |
| Edit `js/config.js` (Supabase URL / key) carelessly | The site **and** the Vercel keep-alive read it. | See *Disaster recovery* in [OPERATIONS.md](docs/OPERATIONS.md). |
| Change tables in the Supabase dashboard | Changes skip the migrations, so a restore wouldn't recreate them. | Add a file in `supabase/migrations/` and run `scripts/migrate.sh`. |
| Leave things in the **Bin** you want to keep | They are deleted automatically after 60 days. | Restore them, or export to Excel first. |

**Free-tier limits** (fine for a club store, but good to know):
- **Supabase:** 500 MB database (this app uses far less than 1 MB per thousand records) and 5 GB of downloads a month. The project pauses after 7 days without database activity, which the keep-alive prevents. If it ever pauses anyway, open the dashboard and click **Restore project**: nothing is lost.
- **GitHub Actions:** the backup workflow takes a few minutes per run, well inside the free allowance. GitHub turns off scheduled workflows after 60 days without activity, and these workflows switch each other back on.
- **Vercel:** one cron job a day, which is what the keep-alive uses.

**Check it's healthy:** **Actions** should show green *Nightly backup* runs twice a day, and `latest/manifest.json` in the backup repo should have today's date.
