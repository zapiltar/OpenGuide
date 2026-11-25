// Weather for framed screens: just the temperature and what the sky is doing.
//
// Forecasts come from MET Norway (api.met.no), which is free, needs no key, allows commercial use and asks
// only for credit (CC BY 4.0) and a User-Agent saying who's asking. US ZIP codes are turned into a place by
// Zippopotam.us. With no ZIP code, Cloudflare's own idea of where the TV's internet address is stands in.

import { HttpError, json } from "./http.js";
import { screenFromToken } from "./tv.js";

const USER_AGENT = "OpenGuide-Bar/1.0 (+https://github.com/zapiltar/OpenGuide)";
/** How long a forecast is used before asking again, and how long an old one will do if the service is down. */
const FRESH_MS = 20 * 60_000;
const STALE_MS = 3 * 3_600_000;

const ZIP = /^\d{5}$/;

/** A US ZIP code's place and position, or a 400 if there's no such ZIP code. */
export async function lookupZip(zip) {
  if (!ZIP.test(zip)) throw new HttpError(400, "Enter a 5-digit US ZIP code");
  let res;
  try {
    res = await fetch(`https://api.zippopotam.us/us/${zip}`, { headers: { "User-Agent": USER_AGENT } });
  } catch {
    throw new HttpError(502, "Couldn't look up the ZIP code just now. Try again in a minute.");
  }
  if (res.status === 404) throw new HttpError(400, `We couldn't find ZIP code ${zip}`);
  if (!res.ok) throw new HttpError(502, "Couldn't look up the ZIP code just now. Try again in a minute.");
  const body = await res.json();
  const p = body.places?.[0];
  const lat = Number(p?.latitude);
  const lon = Number(p?.longitude);
  if (!p || !Number.isFinite(lat) || !Number.isFinite(lon)) throw new HttpError(400, `We couldn't find ZIP code ${zip}`);
  return { zip, lat, lon, place: `${p["place name"]}, ${p["state abbreviation"]}` };
}

/**
 * MET Norway's symbol code ("partlycloudy_night", "heavyrainandthunder") as one of a few kinds the TV has
 * icons for, and whether it's day.
 */
export function skyOf(symbol) {
  const s = String(symbol || "");
  const day = !s.endsWith("_night");
  const base = s.replace(/_(day|night|polartwilight)$/, "");
  let kind = "cloudy";
  if (base.includes("thunder")) kind = "storm";
  else if (base.includes("snow")) kind = "snow";
  else if (base.includes("sleet")) kind = "sleet";
  else if (base.includes("rain")) kind = "rain";
  else if (base === "fog") kind = "fog";
  else if (base === "clearsky") kind = "clear";
  else if (base === "fair" || base === "partlycloudy") kind = "partly";
  return { kind, day };
}

/** The forecast for now from a MET Norway "compact" response: degrees Celsius and the sky. */
export function currentFrom(body, now) {
  const series = body?.properties?.timeseries;
  if (!Array.isArray(series) || !series.length) return null;
  // The latest entry that has started, or the first if none has.
  let entry = series[0];
  for (const t of series) {
    if (Date.parse(t.time) <= now) entry = t;
    else break;
  }
  const celsius = entry.data?.instant?.details?.air_temperature;
  if (typeof celsius !== "number") return null;
  const symbol = entry.data?.next_1_hours?.summary?.symbol_code ?? entry.data?.next_6_hours?.summary?.symbol_code;
  return { celsius, ...skyOf(symbol) };
}

async function forecast(env, lat, lon, now) {
  // Two decimals is about a kilometre, close enough for weather, and what MET Norway asks for in spirit.
  const la = lat.toFixed(2);
  const lo = lon.toFixed(2);
  const key = `${la},${lo}`;
  const cached = await env.DB.prepare("SELECT body, fetched_at FROM weather_cache WHERE key = ?").bind(key).first();
  if (cached && now - cached.fetched_at < FRESH_MS) return JSON.parse(cached.body);
  try {
    const res = await fetch(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${la}&lon=${lo}`, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    await env.DB.prepare("INSERT OR REPLACE INTO weather_cache (key, body, fetched_at) VALUES (?, ?, ?)")
      .bind(key, JSON.stringify(body), now).run();
    return body;
  } catch (e) {
    console.warn("Weather service didn't answer", e);
    return cached && now - cached.fetched_at < STALE_MS ? JSON.parse(cached.body) : null;
  }
}

/**
 * GET /api/tv/weather: {weather: {temp, unit, kind, day, place, source}} or {weather: null} when there's no
 * way to tell where the TV is or the service is down. Fahrenheit in the US, Celsius elsewhere.
 */
/**
 * Where a TV's weather is for: the bar's ZIP code if it set one, or else where Cloudflare places the TV's
 * internet address. {lat, lon, place, us, source}, or null when neither is known. [venue] is its row.
 */
export function weatherPlace(venue, request) {
  if (venue?.weather_lat != null) {
    return { lat: venue.weather_lat, lon: venue.weather_lon, place: venue.weather_place, us: true, source: "zip" };
  }
  const cf = request.cf || {};
  const lat = Number(cf.latitude);
  const lon = Number(cf.longitude);
  if (cf.latitude == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, place: cf.city || null, us: cf.country === "US", source: "ip" };
}

/** GET /api/tv/weather, for versions of the app before 1.5.2. Newer ones ask MET Norway themselves. */
export async function tvWeather(request, env) {
  const screen = await screenFromToken(request, env);
  const venue = await env.DB.prepare("SELECT weather_lat, weather_lon, weather_place FROM venues WHERE id = ?").bind(screen.venue_id).first();
  const now = Date.now();
  const where = weatherPlace(venue, request);
  if (!where) return json({ weather: null });
  const body = await forecast(env, where.lat, where.lon, now);
  const current = body && currentFrom(body, now);
  if (!current) return json({ weather: null });
  const temp = where.us ? current.celsius * 9 / 5 + 32 : current.celsius;
  return json({
    weather: {
      temp: Math.round(temp),
      unit: where.us ? "F" : "C",
      kind: current.kind,
      day: current.day,
      place: where.place,
      source: where.source,
    },
  });
}
