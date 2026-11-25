-- Weather on framed screens. The bar's US ZIP code, and where it is, looked up once when it's saved.
-- With no ZIP code, each TV's weather is for where its internet address places it.
ALTER TABLE venues ADD COLUMN weather_zip TEXT;
ALTER TABLE venues ADD COLUMN weather_lat REAL;
ALTER TABLE venues ADD COLUMN weather_lon REAL;
ALTER TABLE venues ADD COLUMN weather_place TEXT;

-- Recent forecasts, by rounded location, so TVs near each other share one request to the weather service.
CREATE TABLE weather_cache (
  key TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
