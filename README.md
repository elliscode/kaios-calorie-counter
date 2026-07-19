# KaiOS Calorie Counter

Making a calorie counting app for KaiOS, similar to other free offerings. Havne't gotten anything off the ground yet, but this is where it will go when I do.

## Backend

Right now there is no real backend, it's just data preparation for insertion into DynamoDB. Basically, taking all fo the FDA database foods, fixing the errors, removing bad entries, and saving off all the information I need.

## Frontend

TODO

## Future Plans

- **Admin approval page** — a page for reviewing foods submitted via the app's "+ Add New Food" flow (currently landing in DynamoDB with `status: "pending"` via the `/submit` Lambda route). Lets me approve/reject submissions, and includes an "Export to file" button that downloads a JSON file formatted exactly like `s3/2026-07-18-base-foods.json`, ready to upload straight to the S3 bucket as a new dated manifest entry.
- **Recipe tab in the "+ Add Food" panel** — the top of that panel becomes a toggle between two entry types: Food (the current page) and Recipe. The Recipe entry type is essentially a clone of the Diary page, but instead of logging to today's diary, it combines a bunch of foods together into a single reusable recipe.