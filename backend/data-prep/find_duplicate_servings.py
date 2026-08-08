import argparse
import json
from collections import defaultdict


def load_foods(path):
    with open(path, 'r') as f:
        return json.load(f)


def find_duplicates(foods):
    """Yields (food, serving_name, group) for every serving name that
    appears more than once within a single food's servings list."""
    for food in foods:
        by_name = defaultdict(list)
        for serving in food.get('servings') or []:
            by_name[serving.get('name')].append(serving)
        for serving_name, group in by_name.items():
            if len(group) > 1:
                yield food, serving_name, group


def main():
    parser = argparse.ArgumentParser(
        description='Report foods whose servings list has more than one serving with the same name.'
    )
    parser.add_argument('input', nargs='+', help='Food JSON file(s) to check.')
    args = parser.parse_args()

    total_foods = 0
    total_dupe_groups = 0
    for path in args.input:
        foods = load_foods(path)
        total_foods += len(foods)
        for food, serving_name, group in find_duplicates(foods):
            total_dupe_groups += 1
            identical = all(g == group[0] for g in group)
            print(f"{path}: {food['name']!r} (id {food['id']}) has {len(group)}x serving named {serving_name!r}"
                  + (" [identical]" if identical else " [CONFLICTING VALUES]"))
            for serving in group:
                print(f"    {serving}")

    print(f"\nChecked {total_foods} foods across {len(args.input)} file(s); "
          f"found {total_dupe_groups} duplicate-serving-name group(s).")


if __name__ == '__main__':
    main()
