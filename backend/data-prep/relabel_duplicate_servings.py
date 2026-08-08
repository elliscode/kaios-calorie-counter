import argparse
import json

# One-off fix for the 17 duplicate-serving-name groups documented in
# 2026-08-06-duplicate-servings-report.md. Each group is the same food's
# per-100g nutrition profile evaluated at two or three different real portion
# sizes that all collapsed onto the same generic serving name (see the report
# for the root cause in convert_survey_foods_for_kaios_local.py). Sizes below
# were confirmed against the raw USDA Survey (FNDDS) foodPortions for each
# food's fdcId in ../data/surveyDownload.json.
#
# Each entry's serving-size labels are listed in ascending calorie order —
# for every one of these 17 groups, "more calories" and "bigger real portion"
# agree, since all entries within a group share one food's per-gram profile.
RELABELS = {
    ("b5d0319f-720a-58b5-a22a-10929d886e77", "regular"): ["regular", "6-inch sub"],
    ("d2c29faf-8c0b-5102-a018-95e6806c250a", "regular"): ["regular", "6-inch sub"],
    ("df7ae926-0a93-5c6c-81ab-88fac2f9723f", "regular"): ["regular", "6-inch sub"],
    ("3e80d2da-bac9-5a6a-9c6f-4dabbce3a8f3", "regular"): ["regular", "6-inch sub"],
    ("09eec41e-0818-5b28-8d5b-369d75f693b2", "sandwich"): ["open-faced (1 slice bread)", "sandwich (2 slices)"],
    ("5d9af7bf-9086-53d3-a846-a235d1f966f4", "whole"): ["whole (6-inch)", "whole (12-inch)", "whole (16-inch)"],
    ("73e8980c-071e-546c-908b-911a8de762ae", "cake"): ["cake (8-inch round)", "cake (9-inch square)"],
    ("5ec73555-3099-5873-a291-b482b6ceb1b2", "regular"): ["regular (1-layer cake)", "regular (2+ layer cake)"],
    ("5ec73555-3099-5873-a291-b482b6ceb1b2", "large"): ["large (1-layer cake)", "large (2+ layer cake)"],
    ("068e5ec4-4057-5382-9add-6fc44825db17", "quiche"): ["whole (8-inch)", "whole (9-inch)", "whole (10-inch)"],
    ("9c8037ae-0c46-5064-a183-a2e58d88ede1", "piece"): ["piece (1/6 of 8-inch square)", "piece (1/8 of 7x12-inch)"],
    ("db3e2783-4429-5430-b819-3458620bc6e4", "bottle"): ["bottle (6.75 fl oz)", "bottle (10 fl oz)"],
    ("127e5b6e-ecf4-5457-9420-c9acc7a71350", "can or bottle"): ["can or bottle (12 fl oz)", "can or bottle (16 fl oz)"],
    ("467e5c2d-7e89-5563-a3e0-b207a48522e2", "can or bottle"): ["can or bottle (12 fl oz)", "can or bottle (16 fl oz)"],
    ("90ce0043-7760-50d4-9ea4-4be07d358cc7", "can or bottle"): ["can or bottle (12 fl oz)", "can or bottle (16 fl oz)"],
    ("dc700f7d-6eb5-5537-8eeb-acf0aff2037b", "can or bottle"): ["can or bottle (12 fl oz)", "can or bottle (16 fl oz)"],
    ("8d9e7eb7-1a5e-5311-bf4f-fca5b7bf544f", "can or bottle"): ["can or bottle (12 fl oz)", "can or bottle (16 fl oz)"],
}


def load_foods(path):
    with open(path, 'r') as f:
        return json.load(f)


def write_foods(path, foods):
    with open(path, 'w') as f:
        f.write("[\n")
        for i, food in enumerate(foods):
            comma = "," if i < len(foods) - 1 else ""
            f.write(json.dumps(food, separators=(',', ':')) + comma + "\n")
        f.write("]\n")


def main():
    parser = argparse.ArgumentParser(
        description='Relabel the known duplicate-serving-name groups in a foods JSON file '
                     'with size-specific names instead of dropping the extra entries.'
    )
    parser.add_argument('input')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()

    foods = load_foods(args.input)
    remaining = dict(RELABELS)

    for food in foods:
        servings = food.get('servings') or []
        by_name = {}
        for i, serving in enumerate(servings):
            by_name.setdefault(serving.get('name'), []).append(i)
        for name, indices in by_name.items():
            key = (food['id'], name)
            if key not in remaining or len(indices) < 2:
                continue
            new_names = remaining.pop(key)
            if len(indices) != len(new_names):
                raise ValueError(
                    f"{food['name']!r} ({food['id']}) serving {name!r}: expected "
                    f"{len(new_names)} entries, found {len(indices)}"
                )
            ordered = sorted(indices, key=lambda i: servings[i]['calories'])
            for new_name, idx in zip(new_names, ordered):
                servings[idx]['name'] = new_name

    if remaining:
        raise ValueError(f"Never matched: {list(remaining.keys())}")

    write_foods(args.output, foods)
    print(f"Relabeled {len(RELABELS)} duplicate-serving groups; wrote {args.output}")


if __name__ == '__main__':
    main()
