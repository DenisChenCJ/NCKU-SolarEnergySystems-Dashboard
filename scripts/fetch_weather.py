#!/usr/bin/env python3
"""抓取中央氣象署與 Open-Meteo 的資料，整理成儀表板用的 JSON。

只用 Python 標準函式庫。由 GitHub Actions 每小時執行一次。

輸出（預設在 weather/data/）：
  latest.json                    目前狀況與未來預報（網頁一打開就讀這個）
  history/<地點>.json            最近 30 天的每小時觀測、每日日照、預報快照摘要
  snapshots/<地點>/<日期>-<時段>.json   每天 05:30、17:00 兩個決策時間點的完整預報

氣象署授權碼只從環境變數 CWA_API_KEY 讀取，不會寫進任何檔案或紀錄。
"""

import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

TPE = timezone(timedelta(hours=8))  # 台灣時間，沒有日光節約
CWA_BASE = "https://opendata.cwa.gov.tw/api/v1/rest/datastore"
OPEN_METEO = "https://api.open-meteo.com/v1/forecast"

KEEP_DAYS = 30
# 決策時間點的快照：（名稱, 幾點幾分之後的第一次執行就存）。排程會延遲，所以提早半小時開始算
SNAPSHOT_SLOTS = [("0530", 5 * 60), ("1700", 16 * 60 + 30)]
SNAPSHOT_WINDOW_MIN = 180

# 日照燈號：預報日照量 ÷ 晴天理論值
LEVEL_GOOD = 0.65
LEVEL_FAIR = 0.35


class SourceError(Exception):
    """單一資料來源抓取或解析失敗。"""


# ---------- 共用工具 ----------

def scrub(text):
    """錯誤訊息一律先去掉授權碼，避免出現在公開的執行紀錄或 JSON 裡。"""
    key = os.environ.get("CWA_API_KEY", "")
    text = str(text)
    return text.replace(key, "***") if key else text


def http_json(url, params=None, headers=None, tries=4):
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "ncku-solar-dashboard", **(headers or {})})
    last = None
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last = SourceError("HTTP %s" % e.code)
            if e.code in (400, 401, 403, 404):
                break
        except Exception as e:  # 逾時、連線中斷、JSON 格式錯誤
            last = SourceError(scrub("%s: %s" % (type(e).__name__, e)))
        time.sleep(5 * (attempt + 1))  # Open-Meteo 偶爾連線逾時，間隔拉長再試
    raise last


def cwa(dataset, **params):
    key = os.environ.get("CWA_API_KEY", "").strip()
    if not key:
        raise SourceError("尚未設定 CWA_API_KEY")
    url = "%s/%s" % (CWA_BASE, dataset)
    try:
        data = http_json(url, params, {"Authorization": key})
    except SourceError as e:
        if str(e) != "HTTP 401":
            raise
        data = http_json(url, dict(params, Authorization=key))  # 標頭不被接受時，改用網址參數
    if str(data.get("success")).lower() != "true":
        raise SourceError("氣象署回傳失敗")
    return data.get("records") or {}


def g(d, key, default=None):
    """氣象署不同資料集的欄位大小寫不一致（Location／location），兩種都試。"""
    if not isinstance(d, dict):
        return default
    if key in d:
        return d[key]
    return d.get(key[0].lower() + key[1:], default)


def num(x):
    """轉成數字；氣象署用 -99 之類的值代表缺漏。"""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if math.isnan(v) or v <= -90:
        return None
    return v


def parse_time(s):
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s).strip().replace("Z", "+00:00").replace(" ", "T"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TPE)
    return dt.astimezone(TPE)


def iso(dt):
    return dt.astimezone(TPE).isoformat(timespec="minutes") if dt else None


def distance_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(a))


def clear_sky_kwh(lat, day):
    """晴天一整天的理論日照量（kWh/m²）。

    用 FAO-56 的公式：先算大氣層外的日照量，再乘 0.75 當作晴天到達地面的量。
    只和緯度、日期有關，所以不同季節可以用同一把尺來比。
    """
    j = day.timetuple().tm_yday
    phi = math.radians(lat)
    dr = 1 + 0.033 * math.cos(2 * math.pi * j / 365)
    delta = 0.409 * math.sin(2 * math.pi * j / 365 - 1.39)
    ws = math.acos(-math.tan(phi) * math.tan(delta))
    ra = (24 * 60 / math.pi) * 0.0820 * dr * (
        ws * math.sin(phi) * math.sin(delta) + math.cos(phi) * math.cos(delta) * math.sin(ws))
    return 0.75 * ra / 3.6  # MJ → kWh


def sun_level(ratio):
    if ratio is None:
        return None
    return "good" if ratio >= LEVEL_GOOD else "fair" if ratio >= LEVEL_FAIR else "poor"


# ---------- 中央氣象署 ----------

def element_points(element, *keys):
    """把一個預報因子整理成 [(開始, 結束, 值), ...]。"""
    out = []
    for t in g(element, "Time", []) or []:
        start = parse_time(g(t, "StartTime") or g(t, "DataTime"))
        end = parse_time(g(t, "EndTime"))
        values = g(t, "ElementValue", []) or []
        value = values[0] if values else {}
        picked = [g(value, k) for k in keys]
        if all(p is None for p in picked) and value:
            picked = [next(iter(value.values()))] + [None] * (len(keys) - 1)
        if start:
            out.append((start, end, picked))
    return sorted(out, key=lambda p: p[0])


def value_in(points, start, end):
    """取落在 [start, end) 裡的數值平均；沒有就取涵蓋 start 的那一筆。"""
    inside = [num(v[0]) for s, e, v in points if start <= s < end]
    inside = [v for v in inside if v is not None]
    if inside:
        return sum(inside) / len(inside)
    for s, e, v in points:
        if s <= start and (e is None or start < e):
            return num(v[0])
    return None


def fetch_forecast(loc):
    """鄉鎮 3 天預報：天氣現象、溫度、降雨機率、相對濕度。"""
    records = cwa(loc["cwa_dataset"], LocationName=loc["town"],
                  ElementName="天氣現象,溫度,3小時降雨機率,相對濕度")
    groups = g(records, "Locations", []) or []
    towns = [t for grp in groups for t in (g(grp, "Location", []) or [])]
    town = next((t for t in towns if g(t, "LocationName") == loc["town"]), None)
    if not town:
        raise SourceError("預報裡找不到「%s」" % loc["town"])
    elements = {g(e, "ElementName"): e for e in g(town, "WeatherElement", []) or []}
    weather = element_points(elements.get("天氣現象"), "Weather", "WeatherCode")
    temp = element_points(elements.get("溫度"), "Temperature")
    pop = element_points(elements.get("3小時降雨機率"), "ProbabilityOfPrecipitation")
    rh = element_points(elements.get("相對濕度"), "RelativeHumidity")
    if not weather:
        raise SourceError("預報內容是空的")

    periods = []
    for start, end, (text, code) in weather:
        end = end or start + timedelta(hours=3)
        t, p, h = value_in(temp, start, end), value_in(pop, start, end), value_in(rh, start, end)
        periods.append({
            "start": iso(start), "end": iso(end), "weather": text, "code": code,
            "temp": None if t is None else round(t, 1),
            "pop": None if p is None else round(p),
            "humidity": None if h is None else round(h),
        })
    return {"periods": periods}


def fetch_observation(loc):
    """同縣市裡離公所最近、而且有氣溫讀數的綜觀氣象站。"""
    records = cwa("O-A0003-001")
    candidates = []
    for st in g(records, "Station", []) or []:
        geo = g(st, "GeoInfo", {}) or {}
        coords = g(geo, "Coordinates", []) or []
        c = next((c for c in coords if g(c, "CoordinateName") == "WGS84"), coords[0] if coords else None)
        lat, lon = num(g(c, "StationLatitude")), num(g(c, "StationLongitude"))
        el = g(st, "WeatherElement", {}) or {}
        if lat is None or lon is None or num(g(el, "AirTemperature")) is None:
            continue
        same_county = g(geo, "CountyName") == loc["county"]
        candidates.append((not same_county, distance_km(loc["latitude"], loc["longitude"], lat, lon), st, geo, el))
    if not candidates:
        raise SourceError("找不到可用的測站")
    _, dist, st, geo, el = min(candidates, key=lambda c: (c[0], c[1]))

    def r(x, digits=1):
        v = num(x)
        return None if v is None else round(v, digits)

    weather = g(el, "Weather")
    return {
        "station": g(st, "StationName"),
        "station_id": g(st, "StationId"),
        "station_town": "%s%s" % (g(geo, "CountyName") or "", g(geo, "TownName") or ""),
        "distance_km": round(dist, 1),
        "time": iso(parse_time(g(g(st, "ObsTime", {}), "DateTime"))),
        "weather": weather if weather and num(weather) is None and weather != "-99" else None,
        "temp": r(g(el, "AirTemperature")),
        "humidity": r(g(el, "RelativeHumidity"), 0),
        "rain_today": r(g(g(el, "Now", {}), "Precipitation")),
        "wind_speed": r(g(el, "WindSpeed")),
        "pressure": r(g(el, "AirPressure")),
        "uv": r(g(el, "UVIndex")),
        "sunshine_hours": r(g(el, "SunshineDuration")),
    }


def fetch_warnings(loc):
    """縣市目前生效中的天氣警特報。"""
    records = cwa("W-C0033-001", locationName=loc["county"])
    out = []
    for place in g(records, "Location", []) or []:
        if g(place, "LocationName") != loc["county"]:
            continue
        for hz in g(g(place, "HazardConditions", {}), "Hazards", []) or []:
            info, valid = g(hz, "Info", {}) or {}, g(hz, "ValidTime", {}) or {}
            if g(info, "Phenomena"):
                out.append({
                    "phenomena": g(info, "Phenomena"),
                    "significance": g(info, "Significance") or "",
                    "start": iso(parse_time(g(valid, "StartTime"))),
                    "end": iso(parse_time(g(valid, "EndTime"))),
                })
    return out


def fix_position(fix):
    coord = g(fix, "Coordinate")
    if isinstance(coord, str) and "," in coord:
        lon, lat = (num(x) for x in coord.split(",")[:2])
    else:
        lon, lat = num(g(fix, "Longitude")), num(g(fix, "Latitude"))
    return (lat, lon) if lat is not None and lon is not None else None


def fetch_typhoons(loc, now):
    """目前的熱帶氣旋：現在離多遠、預測路徑最近會到多近。"""
    records = cwa("W-C0034-005")
    cyclones = g(g(records, "TropicalCyclones", {}), "TropicalCyclone", []) or []
    out = []
    for tc in cyclones:
        fixes = g(g(tc, "AnalysisData", {}), "Fix", []) or []
        fixes = [(parse_time(g(f, "FixTime")), f) for f in fixes]
        fixes = [(t, f) for t, f in fixes if t and fix_position(f)]
        if not fixes:
            continue
        t, latest = max(fixes, key=lambda x: x[0])
        if now - t > timedelta(hours=36):  # 太舊的定位代表這個氣旋已經消散
            continue
        lat, lon = fix_position(latest)
        item = {
            "name": g(tc, "CwaTyphoonName") or g(tc, "TyphoonName") or "熱帶性低氣壓",
            "time": iso(t),
            "distance_km": round(distance_km(loc["latitude"], loc["longitude"], lat, lon)),
            "max_wind": num(g(latest, "MaxWindSpeed")),
            "closest_km": None, "closest_time": None,
        }
        for f in g(g(tc, "ForecastData", {}), "Fix", []) or []:
            pos, init, tau = fix_position(f), parse_time(g(f, "InitTime")), num(g(f, "Tau"))
            if not pos or not init or tau is None:
                continue
            d = round(distance_km(loc["latitude"], loc["longitude"], *pos))
            if item["closest_km"] is None or d < item["closest_km"]:
                item["closest_km"], item["closest_time"] = d, iso(init + timedelta(hours=tau))
        out.append(item)
    return sorted(out, key=lambda x: x["distance_km"])


# ---------- Open-Meteo ----------

def fetch_solar(loc, today):
    """每小時日照量、雲量、氣溫（今天起 3 天），以及過去 30 天到後天的每日日照總量。"""
    base = {"latitude": loc["latitude"], "longitude": loc["longitude"], "timezone": "Asia/Taipei"}
    hourly = http_json(OPEN_METEO, dict(base, hourly="shortwave_radiation,cloud_cover,temperature_2m",
                                        forecast_days=3)).get("hourly") or {}
    daily = http_json(OPEN_METEO, dict(base, daily="shortwave_radiation_sum,sunrise,sunset",
                                       past_days=KEEP_DAYS + 1, forecast_days=3)).get("daily") or {}
    if not hourly.get("time") or not daily.get("time"):
        raise SourceError("Open-Meteo 回傳內容是空的")

    days = []
    for i, d in enumerate(daily["time"]):
        day = datetime.strptime(d, "%Y-%m-%d").date()
        mj = num(daily["shortwave_radiation_sum"][i])
        kwh = None if mj is None else mj / 3.6
        clear = clear_sky_kwh(loc["latitude"], day)
        ratio = None if kwh is None else min(kwh / clear, 1.0)
        days.append({
            "date": d,
            "sun_kwh": None if kwh is None else round(kwh, 2),
            "clear_kwh": round(clear, 2),
            "sun_ratio": None if ratio is None else round(ratio, 2),
            "level": sun_level(ratio),
            "sunrise": (daily.get("sunrise") or [None] * len(daily["time"]))[i],
            "sunset": (daily.get("sunset") or [None] * len(daily["time"]))[i],
        })
    today_s = today.isoformat()
    return {
        "hourly": {
            "time": [iso(parse_time(t)) for t in hourly["time"]],
            "radiation": hourly.get("shortwave_radiation"),
            "cloud": hourly.get("cloud_cover"),
            "temp": hourly.get("temperature_2m"),
        },
        "daily": [d for d in days if d["date"] >= today_s],
        "past": [{k: d[k] for k in ("date", "sun_kwh", "sun_ratio", "level")} for d in days if d["date"] < today_s],
    }


# ---------- 整理 ----------

def summarize_days(solar, forecast, today):
    """今天、明天、後天各一筆摘要：日照燈號加上白天的天氣、降雨機率、氣溫。"""
    out = []
    for offset in range(3):
        day = (today + timedelta(days=offset)).isoformat()
        item = {"date": day}
        item.update(next((d for d in (solar or {}).get("daily", []) if d["date"] == day), {}))
        periods = [p for p in (forecast or {}).get("periods", []) if p["start"][:10] == day]
        daytime = [p for p in periods if 6 <= int(p["start"][11:13]) < 18] or periods
        temps = [p["temp"] for p in periods if p["temp"] is not None]
        pops = [p["pop"] for p in daytime if p["pop"] is not None]
        words = Counter(p["weather"] for p in daytime if p["weather"])
        item.update({
            "weather": words.most_common(1)[0][0] if words else None,
            "pop_max": max(pops) if pops else None,
            "temp_min": min(temps) if temps else None,
            "temp_max": max(temps) if temps else None,
        })
        out.append(item)
    return out


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


def update_history(out_dir, loc_id, entry, solar_ok, now):
    """更新 30 天紀錄，並在決策時間點存一份完整預報。"""
    path = out_dir / "history" / ("%s.json" % loc_id)
    hist = read_json(path, {})
    cutoff = (now - timedelta(days=KEEP_DAYS)).isoformat()
    cutoff_day = cutoff[:10]

    hourly = {h["t"][:13]: h for h in hist.get("hourly", [])}
    obs = entry.get("observation")
    if obs and obs.get("time") and entry["sources"]["observation"]["ok"]:
        hourly[obs["time"][:13]] = {
            "t": obs["time"], "temp": obs["temp"], "humidity": obs["humidity"],
            "rain_today": obs["rain_today"], "sunshine_hours": obs["sunshine_hours"], "weather": obs["weather"],
        }
    hist["hourly"] = [h for k, h in sorted(hourly.items()) if h["t"] >= cutoff]

    if solar_ok:
        hist["daily_solar"] = [d for d in entry["solar"]["past"] if d["date"] >= cutoff_day]

    snapshots = [s for s in hist.get("snapshots", []) if s["date"] >= cutoff_day]
    minutes = now.hour * 60 + now.minute
    today = now.date().isoformat()
    for slot, start in SNAPSHOT_SLOTS:
        due = start <= minutes < start + SNAPSHOT_WINDOW_MIN
        taken = any(s["date"] == today and s["slot"] == slot for s in snapshots)
        # 沒有日照預報的快照沒有比較價值，等下一次執行再試
        if due and not taken and solar_ok:
            write_json(out_dir / "snapshots" / loc_id / ("%s-%s.json" % (today, slot)), {
                "date": today, "slot": slot, "taken_at": iso(now), "location": entry["name"],
                "days": entry["days"], "forecast": entry.get("forecast"),
                "hourly": entry["solar"]["hourly"],
            })
            snapshots.append({
                "date": today, "slot": slot, "taken_at": iso(now),
                "days": [{k: d.get(k) for k in ("date", "sun_kwh", "sun_ratio", "level")} for d in entry["days"]],
            })
    hist["snapshots"] = snapshots
    hist["updated_at"] = iso(now)
    write_json(path, hist)

    snap_dir = out_dir / "snapshots" / loc_id
    if snap_dir.is_dir():
        for f in snap_dir.glob("*.json"):
            if f.name[:10] < cutoff_day:
                f.unlink()


def build_location(loc, previous, now):
    """抓一個地點的所有資料。某個來源失敗時，沿用上一次的內容並標記失敗。"""
    today = now.date()
    entry = {
        "id": loc["id"], "name": loc["county"] + loc["town"],
        "county": loc["county"], "town": loc["town"], "sources": {},
    }
    jobs = [
        ("forecast", lambda: fetch_forecast(loc)),
        ("observation", lambda: fetch_observation(loc)),
        ("warnings", lambda: fetch_warnings(loc)),
        ("typhoons", lambda: fetch_typhoons(loc, now)),
        ("solar", lambda: fetch_solar(loc, today)),
    ]
    for name, job in jobs:
        try:
            entry[name] = job()
            entry["sources"][name] = {"ok": True, "fetched_at": iso(now), "error": None}
        except Exception as e:
            message = scrub(e if isinstance(e, SourceError) else "%s: %s" % (type(e).__name__, e))
            print("  [失敗] %s：%s" % (name, message), file=sys.stderr)
            entry[name] = previous.get(name)
            last = (previous.get("sources") or {}).get(name) or {}
            entry["sources"][name] = {"ok": False, "fetched_at": last.get("fetched_at"), "error": message}
        else:
            print("  [成功] %s" % name)
    entry["days"] = summarize_days(entry.get("solar"), entry.get("forecast"), today)
    return entry


def main():
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config", default=str(root / "config" / "locations.json"))
    ap.add_argument("--out", default=str(root / "weather" / "data"))
    args = ap.parse_args()

    out_dir = Path(args.out)
    now = datetime.now(TPE)
    locations = json.loads(Path(args.config).read_text(encoding="utf-8"))["locations"]
    previous = {l["id"]: l for l in read_json(out_dir / "latest.json", {}).get("locations", [])}

    entries, any_ok = [], False
    for loc in locations:
        print("%s%s" % (loc["county"], loc["town"]))
        entry = build_location(loc, previous.get(loc["id"], {}), now)
        any_ok = any_ok or any(s["ok"] for s in entry["sources"].values())
        entries.append(entry)

    if not any_ok:
        # 全部失敗就不覆蓋舊檔：網頁會繼續顯示上一次的資料，並依時間標示「資料已過時」
        print("所有資料來源都失敗，保留上一次的資料。", file=sys.stderr)
        return 1

    for entry in entries:
        update_history(out_dir, entry["id"], entry, entry["sources"]["solar"]["ok"], now)
        if entry.get("solar"):
            entry["solar"] = {k: v for k, v in entry["solar"].items() if k != "past"}  # 過去的部分放在 history
    write_json(out_dir / "latest.json", {"schema": 1, "generated_at": iso(now), "locations": entries})
    print("已更新 %s" % (out_dir / "latest.json"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
