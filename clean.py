from pathlib import Path

import pandas as pd


PROJECT_DIR = Path(__file__).resolve().parent
SOURCE_FILE = PROJECT_DIR / "Accidents0515.csv"
OUTPUT_FILE = PROJECT_DIR / "accidents.csv"

if not SOURCE_FILE.exists():
	raise SystemExit(f"Dataset not found: {SOURCE_FILE}\nPlace Accidents0515.csv in the project folder and run again.")

df = pd.read_csv(SOURCE_FILE)
required_columns = {"Longitude", "Latitude"}
missing_columns = required_columns.difference(df.columns)
if missing_columns:
	raise SystemExit(f"Dataset is missing required columns: {', '.join(sorted(missing_columns))}")

coordinates = df[["Longitude", "Latitude"]].copy()
coordinates["Longitude"] = pd.to_numeric(coordinates["Longitude"], errors="coerce")
coordinates["Latitude"] = pd.to_numeric(coordinates["Latitude"], errors="coerce")
coordinates = coordinates.dropna()
coordinates = coordinates[
	coordinates["Longitude"].between(-180, 180)
	& coordinates["Latitude"].between(-90, 90)
]

if coordinates.empty:
	raise SystemExit("No valid longitude/latitude records were found in the dataset.")

coordinates.to_csv(OUTPUT_FILE, index=False)
print(f"Cleaned {len(coordinates):,} locations into {OUTPUT_FILE.name}.")