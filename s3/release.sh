BUCKET=daniel-townsend-kaios-calorie-counter

cp ../frontend-v3/index.html .
cp ../frontend-v3/app.js .
rm -rf css
cp -r ../frontend-v3/css .

aws s3 sync . s3://$BUCKET --exclude "*.sh" --exclude "*.DS_Store" --delete
