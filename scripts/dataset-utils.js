const fs = require("node:fs");

function readDataset(file) {
  if (!fs.existsSync(file)) return { metadata: { countries: {} }, accidents: [] };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Array.isArray(parsed)) {
    const countries = [...new Set(parsed.map(record => record.country).filter(Boolean))];
    return {
      metadata: {
        isDemo: parsed.some(record => record.isDemo),
        countries: Object.fromEntries(countries.map(country => [country, {
          country,
          label: parsed.find(record => record.country === country)?.countryLabel || country.toUpperCase(),
          source: parsed.find(record => record.country === country)?.source || "Imported dataset",
          year: parsed.find(record => record.country === country)?.year || null,
          isDemo: parsed.some(record => record.country === country && record.isDemo)
        }]))
      },
      accidents: parsed
    };
  }
  if (!parsed || !Array.isArray(parsed.accidents)) throw new Error("Existing clusters dataset has an unsupported format.");
  if (!parsed.metadata) parsed.metadata = {};
  if (!parsed.metadata.countries) {
    const country = parsed.metadata.country || parsed.accidents.find(record => record.country)?.country;
    parsed.metadata.countries = country ? { [country]: { ...parsed.metadata, country } } : {};
  }
  for (const [country, metadata] of Object.entries(parsed.metadata.countries)) {
    if (!metadata.sources && metadata.source) {
      metadata.sources = [{
        source: metadata.source,
        sourceUrl: metadata.sourceUrl || null,
        year: metadata.year || null,
        coverage: metadata.coverage || null,
        recordCount: metadata.recordCount || parsed.accidents
          .filter(record => record.country === country)
          .reduce((sum, record) => sum + (Number(record.recordCount) || 1), 0),
        zoneCount: metadata.zoneCount || parsed.accidents.filter(record => record.country === country).length,
        isDemo: Boolean(metadata.isDemo)
      }];
    }
  }
  return parsed;
}

function saveCountryDataset(file, country, countryMetadata, records) {
  const existing = readDataset(file);
  const source = countryMetadata.source || "Imported dataset";
  const accidents = existing.accidents.filter(record => record.country !== country || record.source !== source).concat(records);
  const oldCountryMetadata = existing.metadata.countries[country];
  const oldSources = oldCountryMetadata?.sources || (oldCountryMetadata?.source
    ? [{ source: oldCountryMetadata.source, sourceUrl: oldCountryMetadata.sourceUrl, year: oldCountryMetadata.year, coverage: oldCountryMetadata.coverage, recordCount: oldCountryMetadata.recordCount, zoneCount: oldCountryMetadata.zoneCount, isDemo: oldCountryMetadata.isDemo }]
    : []);
  const sourcesByName = new Map(oldSources.filter(item => item.source !== source).map(item => [item.source, item]));
  sourcesByName.set(source, {
    source,
    sourceUrl: countryMetadata.sourceUrl || null,
    year: countryMetadata.year || null,
    coverage: countryMetadata.coverage || null,
    recordCount: countryMetadata.recordCount || records.reduce((sum, record) => sum + (Number(record.recordCount) || 1), 0),
    zoneCount: records.length,
    isDemo: Boolean(countryMetadata.isDemo)
  });
  const sources = [...sourcesByName.values()];
  const countries = {
    ...existing.metadata.countries,
    [country]: {
      country,
      label: countryMetadata.label || oldCountryMetadata?.label || country.toUpperCase(),
      coverage: [...new Set(sources.map(item => item.coverage).filter(Boolean))].join(" "),
      source: sources.map(item => item.source).join("; "),
      sourceUrl: sources.length === 1 ? sources[0].sourceUrl : null,
      year: [...new Set(sources.map(item => item.year).filter(Boolean))].join(", "),
      recordCount: sources.reduce((sum, item) => sum + (Number(item.recordCount) || 0), 0),
      zoneCount: sources.reduce((sum, item) => sum + (Number(item.zoneCount) || 0), 0),
      isDemo: sources.some(item => item.isDemo),
      sources
    }
  };
  const metadata = {
    ...existing.metadata,
    isDemo: Object.values(countries).some(item => item.isDemo),
    countries,
    updatedAt: new Date().toISOString()
  };
  const temporary = `${file}.tmp`;
  fs.mkdirSync(require("node:path").dirname(file), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify({ metadata, accidents })}\n`);
  fs.renameSync(temporary, file);
}

module.exports = { readDataset, saveCountryDataset };
