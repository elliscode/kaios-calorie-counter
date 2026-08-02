import sys
import json

DEFAULT_PATH = "../../s3/2026-08-02-refined-collated-foods.json"

def find_commas_in_name(items):
    matches = []
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        value = item.get("name")
        if isinstance(value, str) and ',' in value:
            matches.append((f"root[{i}].name", value))
    return matches

file_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PATH

with open(file_path, 'r') as f:
    data = json.load(f)

matches = find_commas_in_name(data)

for path, value in matches:
    print(f"{path}: {value!r}")

print(f"\nFound {len(matches)} \"name\" field(s) containing a comma in {file_path}")
