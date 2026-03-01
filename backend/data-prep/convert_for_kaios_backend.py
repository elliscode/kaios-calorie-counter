import os
import re
import json

import json_stream
from json_stream_to_standard_types import to_standard_types

def show_override_console(p: str, upc: str, item: dict) -> tuple[str, str]:
    """
    Console-based replacement for GUI input.
    Prompts for quantity (q) and unit for a given part `p` and UPC `upc`.
    """

    print(f"Item: {json.dumps(item, indent=2)}")
    print(f"{p} -- {upc}")

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
]
stupid_foods = [
    'Milk, Human',  # it doesnt even have any macros completely useless
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
    {'find': re.compile(r'\u00BC', re.IGNORECASE), 'replace': '1/4'},
    {'find': re.compile(r'[^\u0020-\u007E]', re.IGNORECASE), 'replace': ''},
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
stupid_brands = [
    "Not A Branded Item".lower(),
    "N/A".lower(),
]
needs_more_info_brands = [
    'Farmland'.lower()
]
brand_fixes = {
    "Psst...": "P$$t...",
    "Psst": "P$$t...",
    "Kellogg Company Us": "Kellogg Company",
}
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
    return output.strip()

def upc_cleaner(input_string, count):
    output = str(input_string)
    output = re.sub(r"\D", "", output)
    while len(output) < 12:
        output = f"0{output}"
    return output

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

def parse_portion(q: float, p: str, upc: str = '', item: dict = None):
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
    matching_regex = find_matching_regex(p)
    if matching_regex:
        return actually_parse(q, p, matching_regex)
    return show_override_console(p, upc, item)

def find_matching_regex(p)-> re.Pattern[str] | None:
    for acceptable_serving in acceptable_servings:
        if acceptable_serving.findall(p):
            return acceptable_serving
    return None

def actually_parse(q: float, p: str, pattern: re.Pattern[str]):
    result = pattern.match(p)
    if len(result.groups()) == 1:
        return q, result[1]
    elif len(result.groups()) == 2:
        return eval(result[1]), result[2]
    return None, None

def write_servings(input_servings: set):
    with open("output_servings.jsonl", "w") as servings_file:
        for unique_serving in sorted(input_servings):
            servings_file.write(unique_serving + '\n')

def is_portion_stupid(input_text):
    if input_text in skip_file_servings:
        return True
    for stupid_serving in stupid_servings:
        if stupid_serving.findall(input_text):
            return True
    return False

def parse_skip_servings_file(file_path: str):
    output = set()
    if not os.path.exists(file_path):
        return output
    with open(file_path, 'r') as f:
        line = f.readline()
        while line != "":
            output.add(line.strip())
            line = f.readline()
    return output

def write_skip_file(file_path: str, items: set):
    with open(file_path, 'w') as f:
        for item in items:
            f.write(f"{item}\n")

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


def parse_upc_replacement_file(file_path: str):
    output = {}
    if not os.path.exists(file_path):
        return output
    with open(file_path, 'r') as f:
        line = f.readline()
        while line != "":
            parts = line.split('\t')
            output[parts[0]] = parts[1]
            line = f.readline()
    return output

def get_search_strings(input_string:str):
    output = []
    parts = input_string.split()
    while len(parts) > 0:
        output.append(" ".join(parts))
        parts.pop(0)
    return output


skip_file_servings = parse_skip_servings_file("skip_file.txt")
write_skip_file("skip_file.txt", skip_file_servings)
replacement_servings = parse_replacement_servings_file('replacement-file.txt')
upc_replacement_servings = parse_upc_replacement_file('upc-replacement-file.txt')

unique_servings = set()
count = 0

dynamo_search_maps = {}

with open("output_my_titlecase.jsonl", "w") as output_file, open("output_upcs.tsv", "w") as upc_file:
    with open("../data/surveyDownload.json", 'r') as file:
        raw_data = json_stream.load(file)
        for item_stream in raw_data["SurveyFoods"]:
            item = to_standard_types(item_stream)
            formatted_name = name_cleaner(item['description'])
            if formatted_name in stupid_foods:
                continue
            serving_100g = {'name': 'g', 'quantity': 100.0}
            for nutrient in item['foodNutrients']:
                if nutrient['nutrient']['name'] in macros.keys():
                    serving_100g[macros[nutrient['nutrient']['name']]] = nutrient['amount']
            servings = []
            for portion in item['foodPortions']:
                portion_name = portion['portionDescription']
                quantity = 1
                quantity, portion_name = parse_portion(quantity, portion_name)
                portion_name = portion_name_post_process(portion_name)
                if quantity is None or portion_name is None:
                    sss = portion['portionDescription']
                    if sss not in skip_file_servings:
                        skip_file_servings.add(sss)
                        with open('skip_file.txt', 'a') as f:
                            f.write(f"{sss}\n")
                    continue
                portion_grams = portion['gramWeight']
                ratio = portion_grams / 100.0
                serving = { 'name': portion_name, 'quantity': quantity }
                for key in serving_100g.keys():
                    if key in serving:
                        continue
                    serving[key] = round(serving_100g[key] * ratio, 2)
                servings.append(serving)
            servings.append(serving_100g)

            for serving in servings:
                unique_servings.add(serving['name'])

            json_line = json.dumps({'name': formatted_name, 'servings': servings})
            output_file.write(json_line + "\n")
            upc_file.write(f"{upc_cleaner(count, count)}\t{formatted_name}\n")
            search_strings = get_search_strings(formatted_name)
            for ss in search_strings:
                if ss not in dynamo_search_maps:
                    dynamo_search_maps[ss] = []
            count = count + 1
            if count > 10000:
                count = 0
                write_servings(unique_servings)
    with open("../data/FoodData_Central_branded_food_json_2025-12-18.json", 'r') as file:
        raw_data = json_stream.load(file)
        for item_stream in raw_data["BrandedFoods"]:
            item = to_standard_types(item_stream)
            formatted_name = name_cleaner(item['description'])
            if formatted_name in stupid_foods:
                continue
            upc = upc_cleaner(item['gtinUpc'], count)
            if upc in upc_replacement_servings.keys():
                item['householdServingFullText'] = upc_replacement_servings[upc]
            serving_100g = {'name': 'g', 'quantity': 100.0}
            for nutrient in item['foodNutrients']:
                if nutrient['nutrient']['name'] in macros.keys():
                    serving_100g[macros[nutrient['nutrient']['name']]] = nutrient['amount']

            servings = []

            household_serving = {}
            for key in macros.values():
                if key in item['labelNutrients']:
                    household_serving[key] = item['labelNutrients'][key]['value']

            if 'householdServingFullText' in item:
                portion_name = my_titlecase(item['householdServingFullText'])
                quantity = 1
                quantity, portion_name = parse_portion(quantity, portion_name, upc, item)
                portion_name = portion_name_post_process(portion_name)

                if quantity is None or portion_name is None:
                    sss = my_titlecase(item['householdServingFullText'])
                    if sss not in skip_file_servings:
                        skip_file_servings.add(sss)
                        with open('skip_file.txt', 'a') as f:
                            f.write(f"{sss}\n")

                if quantity is not None and portion_name is not None:
                    serving = { 'name': portion_name, 'quantity': quantity, **household_serving }
                    servings.append(serving)

            if 'servingSizeUnit' in item:
                portion_name = item['servingSizeUnit']
                quantity = item['servingSize']
                quantity, portion_name = parse_portion(quantity, portion_name, upc, item)
                portion_name = portion_name_post_process(portion_name)
                if quantity is None or portion_name is None:
                    sss = item['servingSizeUnit']
                    if sss not in skip_file_servings:
                        skip_file_servings.add(sss)
                        with open('skip_file.txt', 'a') as f:
                            f.write(f"{sss}\n")
                if quantity is not None and portion_name is not None:
                    serving = { 'name': portion_name, 'quantity': quantity, **household_serving }
                    servings.append(serving)

            any_grams = False
            for serving in servings:
                if serving['name'].lower() == 'g':
                    any_grams = True
            if not any_grams:
                servings.append(serving_100g)

            for serving in servings:
                unique_servings.add(serving['name'])

            name = formatted_name
            if 'subbrandName' in item and item['subbrandName'] and item['subbrandName'].lower() not in stupid_brands:
                if item['subbrandName'].lower() not in name.lower():
                    name = item['subbrandName'] + " " + name
                if item['brandName'].lower() not in name.lower() and item['brandName'].lower() not in stupid_brands:
                    name = item['brandName'] + " " + name
            elif 'brandName' in item and item['brandName'].lower() in needs_more_info_brands:
                name = item['brandOwner'] + " " + item['brandName'] + " " + name
            elif 'brandName' in item and item['brandName'] and item['brandName'].lower() not in stupid_brands:
                if item['brandName'].lower() not in name.lower():
                    name = item['brandName'] + " " + name
            elif 'brandOwner' in item and item['brandOwner'] and item['brandOwner'].lower() not in stupid_brands:
                if item['brandOwner'].lower() not in name.lower():
                    name = item['brandOwner'] + " " + name
            name = name_cleaner(name)
            for key, value in brand_fixes.items():
                if key in name:
                    name = name.replace(key, value)
            json_line = json.dumps({'name': name, 'servings': servings, 'upc': upc})
            output_file.write(json_line + "\n")
            upc_file.write(f"{upc}\t{name}\n")
            count = count + 1
            if count > 10000:
                write_servings(unique_servings)
                count = 0


# Save to file
with open('replacement-file.txt', 'w') as f:
    for key, value in replacement_servings.items():
        f.write(f"{key}\t{value['q']}\t{value['unit']}")
write_servings(unique_servings)
