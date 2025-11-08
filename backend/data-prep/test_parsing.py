import re

leading_numbers_regex = re.compile(r"^(\d+\.?\d*)\s+([^(]+)")
print(leading_numbers_regex.match("1 tablespoon"))
result = leading_numbers_regex.match("1.25 slice (4-3/8\" dia x 1/10\" thick) (1 oz)")
print(result.group(1), result.group(2).strip())
print("WELCH'S, CONCORD GRAPE SPREAD, GRAPE".title())
# print(titlecase("WELCH'S, CONCORD GRAPE SPREAD, GRAPE"))
# print(titlecase("DIGIORNO DIGIORNO Croissant Crust Pepperoni 6.5in 10x9oz Carton"))

print('testy' in 'testicle')

# print(titlecase('GENERAL MILLS SALES INC. Food Should Taste Good Guacamole Tortilla Chips'))
print(re.sub(re.compile(r"a{2}", re.IGNORECASE), "AA", "Grade Aa Eggs"))

print(re.sub(re.compile(r'\d+\s*[\'\"]*\s*x\s*\d+\s*[\'\"]*', re.IGNORECASE), '', '1 \'\' X 4\'\' PIECE'))
print(re.sub(re.compile(r'([0-9])\s*(grm|g)$', re.IGNORECASE), r'\1 g', '7G'))
print(re.sub(re.compile(r'([0-9])\s*gr?a?m?s$', re.IGNORECASE), r'\1 g', '7.21 Oz Serving'))

print(eval('0.5'))
print(eval('1/2'))