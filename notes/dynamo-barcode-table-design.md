# Dynamo barcode table design

## TL;DR

The planned barcode lookup DynamoDB table uses **UPC as the sole primary key,
no sort key** — a barcode scan is a pure key-value lookup (scan UPC → GetItem
→ return nutrition), so there's no access pattern that needs a sort key or
range queries.

The one wrinkle: the USDA branded foods source data re-submits/updates the
same UPC under a later `fdcId` sometimes with a tweaked or rebranded name, so
naively loading every row would let load order silently decide which
revision wins. That's why `output_my_titlecase.jsonl` (produced by
`backend/data-prep/convert_for_kaios_barcode_dynamodb.py`) carries a `date`
field (the source's `publicationDate`) on every record.

## Duplicate UPCs in the source data

Out of 454,366 records in `output_my_titlecase.jsonl`, 213 UPCs (429 rows)
appear more than once — e.g.:

```
023700033673
    Tyson Chicken Breast Strips              2019-04-01
    Tyson Gluten Free Chicken Breast Strips  2023-05-25
```

Same barcode, same physical product line, but the USDA dataset has two
separate entries because the product was re-submitted/updated over time.

## How to apply

When the Dynamo importer script gets built: **dedupe by UPC, keeping only the
record with the max `date`**, before writing to the table. Don't just
`PutItem`/`BatchWriteItem` every line from the JSONL file as-is — that leaves
the "winning" revision for those 213 UPCs dependent on load order rather than
being an intentional choice.
