TIMESTAMP=$(date +%s)
zip -r calorie-counter-${TIMESTAMP}.zip . \
  -x "*.zip" \
  -x "*.DS_Store" \
  -x "*.md" \
  -x "*release.sh" \
  -x "tests/*" \
  -x "package.json" \
  -x "package-lock.json" \
  -x "playwright.config.js" \
  -x "node_modules/*"
