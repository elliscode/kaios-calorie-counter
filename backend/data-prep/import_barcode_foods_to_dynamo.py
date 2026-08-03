import json
import boto3
from decimal import Decimal

INPUT_PATH = "output_new_entries_2026_08_02_002.jsonl"
TABLE_NAME = "kaios-calorie-counter-upc-database"

def read_latest_by_upc(file_path: str) -> dict:
    """
    The USDA branded foods dataset re-submits the same UPC under a new fdcId
    over time, so the source file can contain more than one revision per UPC.
    Keep only the one with the most recent `date`, keyed by upc (the table's
    partition key, no sort key).
    """
    latest = {}
    with open(file_path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            item = json.loads(line, parse_float=Decimal)
            upc = item['upc']
            existing = latest.get(upc)
            if existing is None or item['date'] > existing['date']:
                latest[upc] = item
    return latest

def main():
    items_by_upc = read_latest_by_upc(INPUT_PATH)

    table = boto3.resource('dynamodb').Table(TABLE_NAME)
    written = 0
    with table.batch_writer() as batch:
        for item in items_by_upc.values():
            batch.put_item(Item=item)
            written += 1

    print(f"Wrote {written} items to {TABLE_NAME}")

if __name__ == "__main__":
    main()
