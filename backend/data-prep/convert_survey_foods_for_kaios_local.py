import os
import re
import json
import uuid
from datetime import date

import json_stream
from json_stream_to_standard_types import to_standard_types

# Deterministic, name-seeded ids for the base dataset only — re-running this
# script must not reshuffle ids and orphan diary entries / manifest sync state
# that already reference them. Custom foods submitted from the app use a
# purely random GUID instead (see frontend-v3/app.js), since their name can
# still be edited during review after that id has already been handed out.
FOOD_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_DNS, 'kaios-calorie-counter.foods')

def show_override_console(p: str) -> tuple[str, str]:
    """
    Console-based replacement for GUI input.
    Prompts for quantity (q) and unit for a given portion description `p`.
    """

    print(f"{p}")

    while True:
        q_input = input("Enter Quantity (q) or leave empty to skip: ").strip()
        if not q_input.strip():
            print("Skipping entry.")
            return None, None
        try:
            # Evaluate input to handle numbers like '1.0' or '1/2'
            q_value = eval(q_input)
            q_value = str(q_value)
        except Exception:
            print("Invalid input. Quantity must be a number.")
            continue

        unit_value = input("Enter Unit: ").strip()
        if not unit_value:
            print("Unit cannot be empty. Try again.")
            continue

        # Save to file
        with open('replacement-file.txt', 'a') as f:
            replacement_servings[p] = {"q": q_value, "unit": unit_value}
            f.write(f"{p}\t{q_value}\t{unit_value}\n")

        return q_value, unit_value

# fat, carbs, protein, caffeine, alcohol
stupid_servings = [
    re.compile('Guideline amount per fl oz of beverage', re.IGNORECASE),
    re.compile('Quantity not specified', re.IGNORECASE),
    re.compile('Guideline amount per cup of hot cereal', re.IGNORECASE),
    re.compile('N/A', re.IGNORECASE),
    re.compile('None', re.IGNORECASE),
    re.compile(r'^\(.*', re.IGNORECASE),  # leading parenthesis are STUPID
    re.compile(r'^2 (shells|tortillas),.*(taco|seasoning)', re.IGNORECASE),  # i dont even understand these stupid taco servings
    re.compile(r'container, nfs', re.IGNORECASE),  # not sure of the contianer? doesnt that mean, like you dont even know what youre measuring??
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
acceptable_servings = [
    re.compile(r"^(g|ml)$", re.IGNORECASE),
    re.compile(r"^(\d+\.\d+) (\D+)$", re.IGNORECASE),
    re.compile(r"^(\.\d+) (\D+)$", re.IGNORECASE),
    re.compile(r"^(\d+/\d+) (\D+)$", re.IGNORECASE),
    re.compile(r"^(\d+)[ -.\\]+(\D+)$", re.IGNORECASE),
    re.compile(r"^1 (\d+) (oz) container$", re.IGNORECASE),
    re.compile(r"^1 (\d+\.\d+) (oz) container$", re.IGNORECASE),
    re.compile(r"^(1) ([a-z]+)", re.IGNORECASE),
    re.compile(r"^(\d+/\d+) (cup, raw)", re.IGNORECASE),
    re.compile(r"^(\d+) 100 calorie (package)", re.IGNORECASE),
    re.compile(r"^(\d+\.\d+) (oz|ml|g) ", re.IGNORECASE),
    re.compile(r"^(\d+) (oz|ml|g) ", re.IGNORECASE),
    re.compile(r"^(\d+) (oz|ml|g) serving,", re.IGNORECASE),
    re.compile(r"^(\d+.\d+) (oz|ml|g) serving,", re.IGNORECASE),
    re.compile(r"^(.\d+) (oz|ml|g) serving,", re.IGNORECASE),
    re.compile(r"^(\d+)(oz|ml|g)", re.IGNORECASE),
    re.compile(r"^(\d+.\d+)(oz|ml|g)", re.IGNORECASE),
    re.compile(r"^(.\d+)(oz|ml|g)", re.IGNORECASE),
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
# A trailing "(...)" containing a digit (e.g. "(12 fl oz)", "(6" dia)") is what
# distinguishes two differently-sized portions of the same food that otherwise
# reduce to the same unit word (e.g. "1 can or bottle (12 fl oz)" vs "(16 fl
# oz)" both becoming "can or bottle"). The strip-trailing-parens phrase above
# would silently drop that distinguishing text, so it's captured beforehand
# and re-appended to the parsed unit in parse_portion.
size_qualifier_pattern = re.compile(r'\(([^()]*\d[^()]*)\)\s*$')
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
    'Caffeine': 'caffeine',
}

# USDA reports "Energy" twice per food — once in kcal, once in kJ — as two
# separate foodNutrients entries with the *same* nutrient name, distinguished
# only by unitName. Matching on name alone (as this script used to) silently
# takes whichever one comes later in the array, which is sometimes the kJ
# entry (see convert_foundation_foods_for_kaios_local.py's own copy of this
# comment for a concrete example this exact bug produced). Only fat/protein/
# carbs/caffeine/alcohol map to a single unambiguous unit (always grams or
# mg), so this check only needs to apply to the calories mapping.
def is_usable_macro_value(mapped_key, nutrient):
    if mapped_key != 'calories':
        return True
    return (nutrient['nutrient'].get('unitName') or '').strip().lower() == 'kcal'

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

def parse_portion(q: float, p: str) -> tuple:
    """Returns (quantity, unit, size_qualifier). size_qualifier is appended by
    the caller *after* portion_name_post_process, since that strips trailing
    symbols (including a bare closing paren) and would otherwise mangle it."""
    if p in skip_file_servings:
        return None, None, None
    qualifier_match = size_qualifier_pattern.search(p)
    size_qualifier = qualifier_match[1].strip() if qualifier_match else None
    for phrase in servings_fix_these_phrases:
        p = phrase['find'].sub(phrase['replace'], p)
    if is_portion_stupid(p):
        return None, None, None
    if not p or p == 'None':
        p = '1 serving'
    if p in replacement_servings.keys():
        return eval(replacement_servings[p]["q"]), replacement_servings[p]["unit"].strip(), size_qualifier
    matching_regex = find_matching_regex(p)
    if matching_regex:
        parsed_q, unit, leftover_qualifier = actually_parse(q, p, matching_regex)
        return parsed_q, unit, leftover_qualifier or size_qualifier
    unit_q, unit_v = show_override_console(p)
    return unit_q, unit_v, size_qualifier

def find_matching_regex(p)-> re.Pattern[str] | None:
    for acceptable_serving in acceptable_servings:
        if acceptable_serving.findall(p):
            return acceptable_serving
    return None

def actually_parse(q: float, p: str, pattern: re.Pattern[str]):
    result = pattern.match(p)
    if len(result.groups()) == 1:
        parsed_q, unit = q, result[1]
    elif len(result.groups()) == 2:
        parsed_q, unit = eval(result[1]), result[2]
    else:
        return None, None, None
    # Several acceptable_servings patterns aren't end-anchored, so e.g. "1
    # regular" matches inside "1 regular or 6" submarine" and silently
    # truncates the rest. Keep any leftover text that still carries a digit
    # instead of losing the thing that would've distinguished this portion
    # from a same-named sibling.
    leftover = re.sub(r'^(or|and)\s+', '', p[result.end():].strip(' ,'), flags=re.IGNORECASE)
    leftover_qualifier = leftover if re.search(r'\d', leftover) else None
    return parsed_q, unit, leftover_qualifier

def is_portion_stupid(input_text):
    if input_text in skip_file_servings:
        return True
    for stupid_serving in stupid_servings:
        if stupid_serving.findall(input_text):
            return True
    return False

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


skip_file_servings = parse_skip_servings_file("skip_file.txt")
write_skip_file("skip_file.txt", skip_file_servings)
replacement_servings = parse_replacement_servings_file('replacement-file.txt')

foods = []

with open("../data/surveyDownload.json", 'r') as file:
    raw_data = json_stream.load(file)
    for item_stream in raw_data["SurveyFoods"]:
        item = to_standard_types(item_stream)
        formatted_name = name_cleaner(item['description'])
        food_is_stupid = False
        for stupid_food in stupid_foods:
            if stupid_food.findall(formatted_name):
                food_is_stupid = True
                break
        if food_is_stupid:
            continue

        serving_100g = {'name': 'g', 'quantity': 100.0}
        for nutrient in item['foodNutrients']:
            name = nutrient['nutrient']['name']
            if name in macros.keys() and is_usable_macro_value(macros[name], nutrient):
                serving_100g[macros[name]] = nutrient['amount']

        servings = []
        for portion in item['foodPortions']:
            portion_name = portion['portionDescription']
            quantity = 1
            quantity, portion_name, size_qualifier = parse_portion(quantity, portion_name)
            portion_name = portion_name_post_process(portion_name)
            if quantity is None or portion_name is None:
                sss = portion['portionDescription']
                if sss not in skip_file_servings:
                    skip_file_servings.append(sss)
                    with open('skip_file.txt', 'a') as f:
                        f.write(f"{sss}\n")
                continue
            if size_qualifier:
                portion_name = f"{portion_name} ({size_qualifier})"
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

output_path = f"../../s3/{date.today().strftime('%Y_%m_%d')}_survey_foods.json"
with open(output_path, "w") as output_file:
    output_file.write("[\n")
    for i, food in enumerate(foods):
        comma = "," if i < len(foods) - 1 else ""
        output_file.write(json.dumps(food, separators=(',', ':')) + comma + "\n")
    output_file.write("]\n")

print(f"Wrote {len(foods)} foods to {output_path}")
