import argparse
import json


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
        description='Replace the "servings" array of every food in --input whose id matches '
                     'a food in --reference, using the reference food\'s servings. Foods with '
                     'no matching id are copied through unchanged.'
    )
    parser.add_argument('--input', nargs='+', required=True,
                         help='Food JSON file(s) to patch.')
    parser.add_argument('--reference', nargs='+', required=True,
                         help='Food JSON file(s) that are the source of truth for servings, keyed by id.')
    parser.add_argument('--output', required=True,
                         help='Single output file (all --input files combined, in order, with matches patched).')
    args = parser.parse_args()

    reference_by_id = {}
    for ref_path in args.reference:
        for food in load_foods(ref_path):
            existing = reference_by_id.get(food['id'])
            if existing is not None and existing['servings'] != food['servings']:
                print(f"warning: id {food['id']} ({existing['name']!r} / {food['name']!r}) "
                      f"has conflicting servings across reference files; last one wins")
            reference_by_id[food['id']] = food

    combined = []
    patched = 0
    for input_path in args.input:
        for food in load_foods(input_path):
            reference_food = reference_by_id.get(food['id'])
            if reference_food is not None:
                food['servings'] = reference_food['servings']
                patched += 1
            combined.append(food)

    write_foods(args.output, combined)
    print(f"Patched {patched} of {len(combined)} foods; wrote {args.output}")


if __name__ == '__main__':
    main()
