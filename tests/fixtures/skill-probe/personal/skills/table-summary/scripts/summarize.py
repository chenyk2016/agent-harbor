import csv
import sys

path = sys.argv[1]
with open(path, newline="", encoding="utf-8") as handle:
    rows = list(csv.reader(handle))
print(f"rows={len(rows) - 1}")
print("columns=" + ",".join(rows[0]) if rows else "columns=")
print("first=" + ",".join(rows[1]) if len(rows) > 1 else "first=")
