#!/usr/bin/env python3
"""Combine the backup CSVs into one Excel workbook (one sheet per file). Needs openpyxl."""
import csv, os, sys
from openpyxl import Workbook
from openpyxl.styles import Font

src, dest = sys.argv[1], sys.argv[2]
order = [("stock.csv", "Stock"), ("issue_log.csv", "Issue log"), ("bin.csv", "Bin"),
         ("components.csv", "raw_components"), ("stock_entries.csv", "raw_stock_entries"),
         ("issues.csv", "raw_issues"), ("audit_log.csv", "raw_audit_log")]
wb = Workbook()
wb.remove(wb.active)
for fname, title in order:
    path = os.path.join(src, fname)
    if not os.path.exists(path):
        continue
    ws = wb.create_sheet(title)
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.reader(f):
            # Cells starting with = + - @ would be treated as formulas by Excel; keep them as text.
            ws.append([("'" + c) if c[:1] in ("=", "+", "@") or (c[:1] == "-" and not c[1:2].isdigit()) else c for c in row])
    for cell in ws[1]:
        cell.font = Font(bold=True)
    ws.freeze_panes = "A2"
    for col in ws.columns:
        width = max((len(str(c.value or "")) for c in col), default=8)
        ws.column_dimensions[col[0].column_letter].width = min(max(width + 2, 8), 60)
wb.save(dest)
