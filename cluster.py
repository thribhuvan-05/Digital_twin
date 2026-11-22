from pathlib import Path

import pandas as pd
from sklearn.cluster import KMeans


PROJECT_DIR = Path(__file__).resolve().parent
SOURCE_FILE = PROJECT_DIR / "accidents.csv"
OUTPUT_FILE = PROJECT_DIR / "clusters.json"

if not SOURCE_FILE.exists():
	raise SystemExit(f"Cleaned data not found: {SOURCE_FILE}\nRun python clean.py first.")

coordinates = pd.read_csv(SOURCE_FILE)
coordinates = coordinates[["Longitude", "Latitude"]].dropna()
if coordinates.empty:
	raise SystemExit("No valid coordinates found. Run python clean.py with a valid source dataset.")

cluster_count = min(5, len(coordinates))
model = KMeans(n_clusters=cluster_count, random_state=42, n_init=10)
coordinates["cluster"] = model.fit_predict(coordinates[["Longitude", "Latitude"]])
coordinates.to_json(OUTPUT_FILE, orient="records")

print(f"Wrote {len(coordinates):,} locations in {cluster_count} clusters to {OUTPUT_FILE.name}.")