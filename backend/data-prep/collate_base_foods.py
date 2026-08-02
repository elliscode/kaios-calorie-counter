import json

INPUT_PATH = ["../../s3/2026-08-02-refined-collated-foods.json"]
OUTPUT_PATH = "../../s3/collated-data.json"

# Only these serving fields are kept in the output; everything else
# (fiber, calcium, iron, potassium, sodium, vitaminD, cholesterol,
# saturatedFat, sugars, ...) is discarded.
KEPT_SERVING_FIELDS = [
    'name', 'quantity', 'fat', 'carbohydrates', 'protein', 'calories',
    'caffeine', 'alcohol',
]

def read_foods(file_paths: list) -> list:
    foods = []
    for file_path in file_paths:
        with open(file_path, 'r') as f:
            foods.extend(json.load(f))
    return foods

def trim_serving(serving: dict) -> dict:
    return {key: serving[key] for key in KEPT_SERVING_FIELDS if key in serving}

collated = {}

for food in read_foods(INPUT_PATH):
    name = food['name']
    if name not in collated:
        collated[name] = {
            'id': food['id'],
            'name': name,
            'servings': {},
        }
    existing_servings = collated[name]['servings']
    for serving in food.get('servings') or []:
        serving_name = serving['name']
        if serving_name in existing_servings:
            continue
        existing_servings[serving_name] = trim_serving(serving)

output_foods = [
    {**food, 'servings': list(food['servings'].values())}
    for food in collated.values()
]

with open(OUTPUT_PATH, "w") as output_file:
    output_file.write("[\n")
    for i, food in enumerate(output_foods):
        comma = "," if i < len(output_foods) - 1 else ""
        output_file.write(json.dumps(food, separators=(',', ':')) + comma + "\n")
    output_file.write("]\n")

print(f"Wrote {len(output_foods)} foods to {OUTPUT_PATH}")
