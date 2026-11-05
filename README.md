# RC Store Ledger

Inventory and issue ledger for the 11th Committee Robotics Club store.

**Live:** https://robotics-store-management.vercel.app

- **Stock List** — every component with total, available and on-loan units
- **Issue Logs** — who borrowed what (name, roll number, date) and when it came back
- **Bin** — things moved to the bin, restorable or permanently deletable
- Changes appear on every open device instantly; Excel/JSON export from the menu

Built as a static site on Vercel with Supabase (Postgres) for data and login. Backed up nightly to a private repo, with each backup restore-tested.

See **[docs/OPERATIONS.md](docs/OPERATIONS.md)** for setup, maintenance, credentials and disaster recovery.
