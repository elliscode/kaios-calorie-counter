import sys
import json
from datetime import date

USAGE = "usage: python find_new_entries.py <base.jsonl> <other.jsonl> [more.jsonl ...]"

if len(sys.argv) < 3:
    print(USAGE, file=sys.stderr)
    sys.exit(1)

base_path = sys.argv[1]
other_paths = sys.argv[2:]
output_path = f"output_new_entries_{date.today().strftime('%Y_%m_%d')}.jsonl"

base_upcs = set()
with open(base_path, 'r') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        base_upcs.add(json.loads(line)['upc'])

seen_upcs = set()
new_count = 0
with open(output_path, 'w') as out:
    for path in other_paths:
        with open(path, 'r') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                entry = json.loads(line)
                upc = entry['upc']
                if upc in base_upcs or upc in seen_upcs:
                    continue
                seen_upcs.add(upc)
                new_count += 1
                out.write(json.dumps(entry) + '\n')

print(f"{base_path}: {len(base_upcs)} upcs", file=sys.stderr)
print(f"Found {new_count} new entries across {len(other_paths)} file(s)", file=sys.stderr)
print(f"Wrote {output_path}", file=sys.stderr)
