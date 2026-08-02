import os
import re
import json
import uuid

# Same namespace as convert_for_kaios_local.py: ids are a deterministic
# function of the cleaned food name, so a Foundation food that happens to
# share a name with an existing Survey food intentionally lands on the same
# id (dedup) instead of orphaning diary entries / manifest sync state.
FOOD_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_DNS, 'kaios-calorie-counter.foods')

# fat, carbs, protein, caffeine, alcohol
stupid_servings = [
    re.compile('Guideline amount per fl oz of beverage', re.IGNORECASE),
    re.compile('Quantity not specified', re.IGNORECASE),
    re.compile('Guideline amount per cup of hot cereal', re.IGNORECASE),
    re.compile('N/A', re.IGNORECASE),
    re.compile('None', re.IGNORECASE),
    re.compile(r'^\(.*', re.IGNORECASE),  # leading parenthesis are STUPID
]
stupid_foods = [
    re.compile(r'Milk, Human', re.IGNORECASE),  # it doesnt even have any macros completely useless
    re.compile(r'.*As Ingredient.*', re.IGNORECASE),
    re.compile(r'.*Ns As To Part.*', re.IGNORECASE),
    re.compile(r'Infant Formula.*', re.IGNORECASE),
    re.compile(r'Baby Formula.*', re.IGNORECASE),
    re.compile(r'.*\bns\b.*', re.IGNORECASE),
    re.compile(r'.*\bnfs\b.*', re.IGNORECASE),
]
# Foundation foods' RACC (Reference Amount Customarily Consumed) portion is a
# regulatory bookkeeping unit, not something a person would ever pick as a
# serving in the app, and it's always redundant with the 100g serving anyway.
skip_measure_units = [
    re.compile(r'^RACC$', re.IGNORECASE),
]
servings_fix_these_phrases = [
    {'find': re.compile(r'¼', re.IGNORECASE), 'replace': '1/4'},
    {'find': re.compile(r'[^ -~]', re.IGNORECASE), 'replace': ''},
    {'find': re.compile(r'\s*\([^()]+\)$', re.IGNORECASE), 'replace': ''},
    {'find': re.compile(r'\babout\b', re.IGNORECASE), 'replace': ''},
    {'find': re.compile(r'^\s+', re.IGNORECASE), 'replace': ''},
    {'find': re.compile(r'\s+$', re.IGNORECASE), 'replace': ''},
    {'find': re.compile(r'\s+', re.IGNORECASE), 'replace': ' '},
    {'find': re.compile(r'\(\d+g\)\s*', re.IGNORECASE), 'replace': ''},
]
servings_post_processing = [
    {'find': re.compile(r'^"+ ([a-z]+)\s*.*', re.IGNORECASE), 'replace': r'1-inch \1'},
    {'find': re.compile(r'^abr$', re.IGNORECASE), 'replace': 'bar'},
    {'find': re.compile(r'^[^a-zA-Z0-9]+', re.IGNORECASE), 'replace': ''},  # symbols at the front
    {'find': re.compile(r'[^a-zA-Z0-9]+$', re.IGNORECASE), 'replace': ''},  # symbols at the end
    {'find': re.compile(r'^$', re.IGNORECASE), 'replace': 'serving'},  # Empty, im just gonna guess
    {'find': re.compile(r'(\d) inch', re.IGNORECASE), 'replace': r'\1-inch'},
    {'find': re.compile(r'(tbsp|tablespoon|tbp)s*\.*', re.IGNORECASE), 'replace': r'Tablespoons'}, # Tablespoons
    {'find': re.compile(r'(tsp|teaspoon|tbp)s*\.*', re.IGNORECASE), 'replace': r'teaspoons'}, # teaspoons
    {'find': re.compile(r'\s*\|.*$', re.IGNORECASE), 'replace': r''},
    {'find': re.compile(r', nfs$', re.IGNORECASE), 'replace': r''},
]
servings_post_processing_skip_these = [
    re.compile(r'^\.$', re.IGNORECASE),  # A single dot? really?
    re.compile(r'^al$', re.IGNORECASE),  # I think they meant grams
    re.compile(r'^G ', re.IGNORECASE),  # I think theese were all supposed to be grams
    re.compile(r'^ap[prox]*$', re.IGNORECASE),  # why
    re.compile(r'^amout$', re.IGNORECASE),  # what
    re.compile(r'^amoun$', re.IGNORECASE),  # what
    re.compile(r'^amours$', re.IGNORECASE),  # what
    re.compile(r'^as$', re.IGNORECASE),  # what
]
macros = {
    'Total lipid (fat)': 'fat',
    'Carbohydrate, by difference': 'carbohydrates',
    'Protein': 'protein',
    'Energy': 'calories',
    'Alcohol, ethyl': 'alcohol',
    'Fatty acids, total saturated': 'saturatedFat',
    'not-present-1': 'transFat',
    'Cholesterol': 'cholesterol',
    'Sodium, Na': 'sodium',
    'Fiber, total dietary': 'fiber',
    'Total Sugars': 'sugars',
    'Vitamin D (D2 + D3)': 'vitaminD',
    'Calcium, Ca': 'calcium',
    'Iron, Fe': 'iron',
    'Potassium, K': 'potassium',
    'not-present-2': 'addedSugar',
    'Caffeine': 'caffeine',
}
# Foundation foods don't consistently use the same nutrient names as Survey
# foods (e.g. some only report "Energy (Atwater ...)" instead of a plain
# "Energy"). These only fill in a macro if `macros` didn't already find one,
# so the preferred name above always wins when both are present.
macros_fallback = {
    'Energy (Atwater Specific Factors)': 'calories',
    'Energy (Atwater General Factors)': 'calories',
    'Sugars, Total': 'sugars',
}

apostrophe_s = re.compile(r"'S")
whitespace = re.compile(r"\s+")
acai_berry = re.compile(r"AA BERRY", re.IGNORECASE)
two_as = re.compile(r"\ba{2}\b", re.IGNORECASE)
dumb_chars = re.compile(r"[^a-z0-9.,\- %&]", re.IGNORECASE)

def my_titlecase(input_string):
    output = input_string
    output = re.sub(apostrophe_s, "'s", output.title())
    output = re.sub(whitespace, " ", output)
    output = re.sub(acai_berry, "Acai Berry", output)
    output = re.sub(two_as, "AA", output)
    return output.strip()

def name_cleaner(input_string):
    output = input_string
    output = my_titlecase(output)
    output = re.sub(dumb_chars, "", output)
    output = re.sub(r"\s+", " ", output)
    return output.strip()

def portion_name_post_process(portion_name: str):
    p = portion_name
    if not p:
        return p
    for phrase in servings_post_processing:
        p = phrase['find'].sub(phrase['replace'], p)
    for phrase in servings_post_processing_skip_these:
        if phrase.findall(p):
            return None
    return p

def is_portion_stupid(input_text):
    if input_text in skip_file_servings:
        return True
    for stupid_serving in stupid_servings:
        if stupid_serving.findall(input_text):
            return True
    return False

def parse_portion(q: float, p: str):
    """
    Unlike the Survey/Branded formats, Foundation foodPortions already carry
    a structured quantity (amount) and unit (measureUnit.name / modifier), so
    there's no free-text regex parsing to do here - just cleanup/filtering of
    the composed name, plus an escape hatch for manual overrides.
    """
    if p in skip_file_servings:
        return None, None
    for phrase in servings_fix_these_phrases:
        p = phrase['find'].sub(phrase['replace'], p)
    if is_portion_stupid(p):
        return None, None
    if not p or p == 'None':
        p = '1 serving'
    if p in replacement_servings.keys():
        return eval(replacement_servings[p]["q"]), replacement_servings[p]["unit"].strip()
    return q, p

def build_portion_name(portion: dict) -> str | None:
    unit_name = ((portion.get('measureUnit') or {}).get('name') or '').strip()
    if not unit_name:
        return None
    for skip_unit in skip_measure_units:
        if skip_unit.findall(unit_name):
            return None
    descriptor = (portion.get('modifier') or portion.get('portionDescription') or '').strip()
    if descriptor.lower() in ('', 'none'):
        return unit_name
    return f"{unit_name} {descriptor}"

def parse_skip_servings_file(file_path: str):
    output = []
    if not os.path.exists(file_path):
        return output
    with open(file_path, 'r') as f:
        line = f.readline()
        while line != "":
            content = line.strip()
            if content not in output:
                output.append(content)
            line = f.readline()
    return output

def write_skip_file(file_path: str, items: list):
    with open(file_path, 'w') as f:
        for thing in items:
            f.write(f"{thing}\n")

def parse_replacement_servings_file(file_path: str):
    output = {}
    if not os.path.exists(file_path):
        return output
    with open(file_path, 'r') as f:
        line = f.readline()
        while line != "":
            parts = line.split('\t')
            output[parts[0]] = {"q": parts[1], "unit": parts[2]}
            line = f.readline()
    return output


skip_file_servings = parse_skip_servings_file("skip_file_foundation.txt")
write_skip_file("skip_file_foundation.txt", skip_file_servings)
replacement_servings = parse_replacement_servings_file('replacement-file-foundation.txt')

foods = []

with open("../data/FoodData_Central_foundation_food_json_2026-04-30.json", 'r') as file:
    raw_data = json.load(file)
    for item in raw_data["FoundationFoods"]:
        if not item:
            continue
        formatted_name = name_cleaner(item['description'])
        food_is_stupid = False
        for stupid_food in stupid_foods:
            if stupid_food.findall(formatted_name):
                food_is_stupid = True
                break
        if food_is_stupid:
            continue

        serving_100g = {'name': 'g', 'quantity': 100.0}
        for nutrient in item.get('foodNutrients') or []:
            if nutrient['nutrient']['name'] in macros.keys():
                serving_100g[macros[nutrient['nutrient']['name']]] = nutrient['amount']
        for nutrient in item.get('foodNutrients') or []:
            name = nutrient['nutrient']['name']
            if name in macros_fallback.keys() and macros_fallback[name] not in serving_100g:
                serving_100g[macros_fallback[name]] = nutrient['amount']

        servings = []
        for portion in item.get('foodPortions') or []:
            portion_name = build_portion_name(portion)
            if portion_name is None:
                continue
            quantity = portion.get('amount', portion.get('value'))
            if quantity is None:
                continue
            quantity, portion_name = parse_portion(quantity, portion_name)
            portion_name = portion_name_post_process(portion_name)
            if quantity is None or portion_name is None:
                sss = build_portion_name(portion)
                if sss and sss not in skip_file_servings:
                    skip_file_servings.append(sss)
                    with open('skip_file_foundation.txt', 'a') as f:
                        f.write(f"{sss}\n")
                continue
            portion_grams = portion['gramWeight']
            ratio = portion_grams / 100.0
            serving = {'name': portion_name, 'quantity': quantity}
            for key in serving_100g.keys():
                if key in serving:
                    continue
                serving[key] = round(serving_100g[key] * ratio, 2)
            servings.append(serving)
        servings.append(serving_100g)

        food_id = str(uuid.uuid5(FOOD_NAMESPACE, formatted_name))
        foods.append({'id': food_id, 'name': formatted_name, 'servings': servings})

with open("output_kaios_foundation_local.json", "w") as output_file:
    output_file.write("[\n")
    for i, food in enumerate(foods):
        comma = "," if i < len(foods) - 1 else ""
        output_file.write(json.dumps(food, separators=(',', ':')) + comma + "\n")
    output_file.write("]\n")

print(f"Wrote {len(foods)} foods to output_kaios_foundation_local.json")
