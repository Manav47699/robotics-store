# RoboStore backups (private)

Nightly backups of the Robotics Club store database. **This repo must stay private** — it contains borrower names and roll numbers.

A new backup is added every night at 00:00 Nepal time by the *Nightly backup* workflow in the main `robotics-store-management` repo. Before it is saved here, each backup is restored into a temporary database and checked, so every backup in this repo is known to be restorable.

## What's here

```
latest/                 ← last night's backup (overwritten nightly)
monthly/YYYY-MM/        ← first backup of each month, kept forever
```

Each backup folder contains:

| File | What it is |
|---|---|
| `database.sql` | **The real backup.** Rebuilds the whole database: tables, stock rules, history log, access rules, and data. |
| `robostore.xlsx` | Everything in one Excel file — open it to read the data. |
| `stock.csv`, `issue_log.csv`, `bin.csv` | Readable tables (open with Excel / Google Sheets). |
| `components.csv`, `stock_entries.csv`, `issues.csv`, `staff.csv`, `audit_log.csv` | Raw database tables. `audit_log` has every change ever made, including deleted rows. |
| `manifest.json` | Date, row counts and checksums. |

## I need the data as it was on a specific day

Every night is a separate commit. On GitHub: open `latest/`, click **History**, pick the date, then **Browse files** to download that night's files.

## I need to restore the database

Follow `docs/OPERATIONS.md` → *Disaster recovery* in the main repo. Short version:

```bash
scripts/restore.sh path/to/backup-folder "postgresql://…session-pooler-url…"
scripts/create-login.sh
```
