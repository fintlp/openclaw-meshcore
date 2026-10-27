#!/usr/bin/env python3
"""Build a node map from openclaw-meshcore state files. Zero airtime: reads files only.

Usage:
  python3 docs/recipes/meshcore-map.py [--state ~/.openclaw/state] [--account default]
                          [--stale-days 7] [--out meshcore-map.html] [--link]

Prints a short text summary (fits a chat reply) and writes a self-contained
Leaflet HTML map. With --link it also prints a geojson.io link that opens the
same stations as an interactive map in any browser (see docs/USE-CASES.md,
recipe 7). Use --out '' to skip the HTML file. Standard library only.
"""
import argparse, html, json, os, sys, time, urllib.parse

TYPES = {0: "unknown", 1: "companion", 2: "repeater", 3: "room server", 4: "sensor"}
COLORS = {"self": "#2563eb", "companion": "#16a34a", "repeater": "#dc2626",
          "room server": "#9333ea", "sensor": "#d97706", "unknown": "#6b7280"}


def decode_path(length, path_hex):
    """MeshCore out_path_len: low 6 bits = hops, top 2 bits = hash size - 1, 0xFF = unknown."""
    if length is None:
        return None
    l = int(length) & 0xFF
    if l == 0xFF:
        return None
    hops, size = l & 63, (l >> 6) + 1
    try:
        raw = bytes.fromhex(path_hex or "")
    except ValueError:
        return None  # malformed path data: draw no route rather than guess
    if len(raw) < hops * size:
        return None
    return [raw[i * size:(i + 1) * size].hex() for i in range(hops) if len(raw) >= (i + 1) * size]


def age_text(seconds):
    if seconds is None:
        return "never seen on air"
    for unit, n in (("d", 86400), ("h", 3600), ("min", 60)):
        if seconds >= n:
            return f"{seconds // n:.0f} {unit} ago"
    return "just now"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", default=os.path.expanduser("~/.openclaw/state"))
    ap.add_argument("--account", default="default")
    ap.add_argument("--stale-days", type=float, default=7)
    ap.add_argument("--out", default="meshcore-map.html", help="HTML map path; '' to skip")
    ap.add_argument("--link", action="store_true", help="also print a geojson.io link (opens the map in any browser)")
    a = ap.parse_args()

    book = json.load(open(os.path.join(a.state, "meshcore-advert-contacts.json")))
    rows = book["contacts"] if isinstance(book, dict) else book
    try:
        status = json.load(open(os.path.join(a.state, "meshcore-node-status.json")))
    except FileNotFoundError:
        status = {}

    now = time.time()
    self_key = (status.get("pubkey") or "").lower()
    nodes, seen, skipped = [], set(), {"other account": 0, "no position": 0, "duplicate": 0}

    pos = status.get("position") or {}
    if pos.get("lat") and pos.get("lon"):
        nodes.append({"name": status.get("name", "gateway"), "kind": "self", "lat": pos["lat"],
                      "lon": pos["lon"], "age": None, "stale": False, "prefix": self_key[:12],
                      "note": "this gateway's node (advertised position)"})

    for r in rows:
        key = (r.get("publicKeyHex") or "").lower()
        if r.get("accountId", a.account) != a.account:
            skipped["other account"] += 1
            continue
        if not key or key in seen:
            skipped["duplicate"] += 1
            continue
        seen.add(key)
        if self_key and (key.startswith(self_key) or self_key.startswith(key)):
            continue  # the gateway itself, already placed from node status
        lat, lon = r.get("lat") or 0, r.get("lon") or 0
        if not lat and not lon:
            skipped["no position"] += 1
            continue
        last = r.get("lastAdvert") or 0
        age = now - last if last else None
        nodes.append({
            "name": r.get("advName") or key[:12], "kind": TYPES.get(r.get("type"), "unknown"),
            "lat": lat, "lon": lon, "age": age,
            "stale": age is None or age > a.stale_days * 86400,
            "prefix": key[:12], "last": last, "path": decode_path(r.get("outPathLen"), r.get("outPathHex")),
            "note": "",
        })

    # Route lines: gateway -> each repeater hash on a contact's known out path -> contact.
    by_prefix = {n["prefix"]: n for n in nodes}
    lines = []
    origin = next((n for n in nodes if n["kind"] == "self"), None)
    for n in nodes:
        hops = n.get("path")
        if origin is None or hops is None or n["kind"] == "self":
            continue
        chain = [origin]
        for h in hops:
            match = [m for p, m in by_prefix.items() if p.startswith(h)]
            if len(match) != 1:
                chain = None  # unresolved or ambiguous hop: do not guess a line
                break
            chain.append(match[0])
        if chain:
            chain.append(n)
            lines.append([[c["lat"], c["lon"]] for c in chain])

    # Text summary.
    contacts = [n for n in nodes if n["kind"] != "self"]
    print(f"MeshCore map ({a.account}): {len(contacts)} contacts with position, "
          f"{sum(1 for n in contacts if not n['stale'])} heard within {a.stale_days:g} days, "
          f"{sum(1 for n in contacts if n['kind'] == 'repeater')} repeaters")
    for n in nodes:
        print(f"- {n['name']} [{n['kind']}] {n['lat']:.5f},{n['lon']:.5f} "
              f"{'' if n['kind'] == 'self' else age_text(n['age'])}{' (stale)' if n['stale'] else ''}")
    hidden = {k: v for k, v in skipped.items() if v}
    if hidden:
        print("Not shown: " + ", ".join(f"{v} {k}" for k, v in hidden.items()))

    if a.link:
        print(geojson_link(nodes, lines))

    if not a.out:
        return
    for n in nodes:
        n["label"] = "" if n["kind"] == "self" else age_text(n["age"])
        n.pop("path", None)
    page = TEMPLATE.replace("__DATA__", json.dumps({"nodes": nodes, "lines": lines, "colors": COLORS}))
    page = page.replace("__GENERATED__", html.escape(time.strftime("%Y-%m-%d %H:%M")))
    with open(a.out, "w") as f:
        f.write(page)
    print(f"Map written to {a.out}")


def geojson_link(nodes, lines):
    """geojson.io link with the stations in the URL fragment. Browsers never send the
    fragment to the server; the page decodes it locally. Styling uses simplestyle keys."""
    feats = []
    for n in nodes:
        props = {"name": n["name"], "type": "gateway" if n["kind"] == "self" else n["kind"],
                 "marker-color": COLORS.get(n["kind"], COLORS["unknown"]),
                 "marker-size": "large" if n["kind"] == "self" else "medium"}
        if n["kind"] != "self":
            props["last advert"] = (time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(n["last"]))
                                    if n.get("last") else "never")
            if n["stale"]:
                props["stale"] = True
        feats.append({"type": "Feature", "properties": props,
                      "geometry": {"type": "Point", "coordinates": [round(n["lon"], 5), round(n["lat"], 5)]}})
    for l in lines:
        feats.append({"type": "Feature", "properties": {"name": "known route", "stroke": "#64748b", "stroke-width": 2},
                      "geometry": {"type": "LineString", "coordinates": [[round(x, 5), round(y, 5)] for y, x in l]}})
    data = json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":"), ensure_ascii=False)
    return "https://geojson.io/#data=data:application/json," + urllib.parse.quote(data, safe="-_.!~*'()")


TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MeshCore Node Map</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<style>
:root{--bg:#f8fafc;--fg:#0f172a;--muted:#64748b;--card:#ffffff;--line:#e2e8f0}
@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--fg:#e2e8f0;--muted:#94a3b8;--card:#111a2e;--line:#1e293b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,sans-serif}
header{padding:12px 16px;border-bottom:1px solid var(--line)}h1{font-size:16px;margin:0}
.sub{color:var(--muted);font-size:12px}#map{height:calc(100vh - 140px);min-height:320px}
.legend{display:flex;flex-wrap:wrap;gap:12px;padding:8px 16px;font-size:12px;color:var(--muted)}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:-1px}
</style></head><body>
<header><h1>MeshCore Node Map</h1>
<div class="sub">Generated __GENERATED__ from the gateway contact book. Positions are what each node advertises, not verified. Faded = not heard recently.</div></header>
<div id="map"></div><div class="legend" id="legend"></div>
<script>
const D=__DATA__;
const map=L.map('map');
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
const pts=[];const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
D.lines.forEach(l=>L.polyline(l,{color:'#64748b',weight:2,dashArray:'4 4'}).addTo(map));
D.nodes.forEach(n=>{const c=D.colors[n.kind]||D.colors.unknown;
 L.circleMarker([n.lat,n.lon],{radius:n.kind==='self'?9:7,color:c,fillColor:c,fillOpacity:n.stale?0.25:0.85,opacity:n.stale?0.4:1,weight:2})
  .bindPopup('<b>'+esc(n.name)+'</b><br>'+esc(n.kind)+(n.label?' · last advert '+esc(n.label):'')+'<br><code>'+esc(n.prefix)+'</code>'+(n.note?'<br>'+esc(n.note):''))
  .addTo(map);pts.push([n.lat,n.lon]);});
if(pts.length){map.fitBounds(pts,{padding:[40,40],maxZoom:16});}else{map.setView([47.5,14.5],7);}
const kinds=[...new Set(D.nodes.map(n=>n.kind))];
document.getElementById('legend').innerHTML=kinds.map(k=>'<span><span class="dot" style="background:'+(D.colors[k]||D.colors.unknown)+'"></span>'+esc(k==='self'?'gateway':k)+'</span>').join('')+(D.lines.length?'<span>dashed = known route</span>':'');
</script></body></html>
"""

if __name__ == "__main__":
    sys.exit(main())
