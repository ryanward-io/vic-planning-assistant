// Victorian planning lookup: address -> property -> zones and overlays -> planning scheme clauses.
// Everything is read live from official open services; there is no backend.

const ARCGIS = "https://services-ap1.arcgis.com/P744lA0wf4LlBZ84/ArcGIS/rest/services";
const PLANNING = `${ARCGIS}/Vicmap_Planning/FeatureServer`;
const ADDRESS = `${ARCGIS}/Vicmap_Address/FeatureServer/0`;
const PROPERTY = `${ARCGIS}/Vicmap_Property/FeatureServer/0`;
const LAYER = { overlays: 2, zones: 3, bushfire: 9 };
const SCHEME_API = "https://api.app.planning.vic.gov.au/planning/v2";
const SCHEME_SITE = "https://planning-schemes.app.planning.vic.gov.au";

const STYLE_LIGHT = "https://tiles.openfreemap.org/styles/positron";
const STYLE_DARK = "https://tiles.openfreemap.org/styles/dark";
const START = { center: [145.09, -37.985], zoom: 11.5 }; // City of Kingston

const ROAD_TYPES = {
  RD: "ROAD", ROAD: "ROAD", ST: "STREET", STREET: "STREET", AV: "AVENUE", AVE: "AVENUE", AVENUE: "AVENUE",
  CT: "COURT", CRT: "COURT", COURT: "COURT", CR: "CRESCENT", CRES: "CRESCENT", CRESCENT: "CRESCENT",
  DR: "DRIVE", DRV: "DRIVE", DRIVE: "DRIVE", PDE: "PARADE", PARADE: "PARADE", PL: "PLACE", PLACE: "PLACE",
  HWY: "HIGHWAY", HIGHWAY: "HIGHWAY", BVD: "BOULEVARD", BLVD: "BOULEVARD", BOULEVARD: "BOULEVARD",
  LN: "LANE", LANE: "LANE", GR: "GROVE", GROVE: "GROVE", TCE: "TERRACE", TERRACE: "TERRACE", WAY: "WAY",
  CL: "CLOSE", CLOSE: "CLOSE", ESP: "ESPLANADE", ESPLANADE: "ESPLANADE", SQ: "SQUARE", SQUARE: "SQUARE",
  CCT: "CIRCUIT", CIR: "CIRCUIT", CIRCUIT: "CIRCUIT", RISE: "RISE", WALK: "WALK", HWAY: "HIGHWAY",
};

// Colour group for each zone family (codes without the schedule number).
const ZONE_GROUPS = {
  res: ["GRZ", "NRZ", "RGZ", "MUZ", "TZ", "LDRZ", "HCTZ", "R1Z", "R2Z", "R3Z"],
  com: ["C1Z", "C2Z", "C3Z", "ACZ", "CCZ", "PRZ", "DZ"],
  ind: ["IN1Z", "IN2Z", "IN3Z", "SPZ"],
  pub: ["PUZ", "PPRZ", "PCRZ"],
  rural: ["GWZ", "GWAZ", "RCZ", "FZ", "RLZ", "RAZ"],
  trans: ["TRZ", "RDZ"],
  spec: ["SUZ", "CDZ", "UFZ", "UGZ", "PDZ", "ERZ", "CA"],
};

const $ = (sel) => document.querySelector(sel);
const statusEl = $("#status");
const resultsEl = $("#results");
const choicesEl = $("#choices");
let map;
let lookupSeq = 0;

// ---------- small helpers ----------

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style") node.setAttribute("style", v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : String(c));
  }
  return node;
}

const cache = new Map();
function cached(key, fn) {
  if (!cache.has(key)) cache.set(key, fn().catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
}

async function getJSON(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).hostname}`);
  return res.json();
}

async function arcgisQuery(layerUrl, params) {
  const body = new URLSearchParams({ f: "json", ...params });
  const data = await getJSON(`${layerUrl}/query`, { method: "POST", body });
  if (data.error) throw new Error([data.error.message, ...(data.error.details || [])].filter(Boolean).join(" ") || "map service error");
  return data;
}

const sqlText = (s) => `'${String(s).replace(/'/g, "''")}'`;
const zoneFamily = (code) => code.replace(/\d+$/, "");
function zoneGroup(code) {
  const fam = zoneFamily(code);
  for (const [g, list] of Object.entries(ZONE_GROUPS)) if (list.includes(fam)) return g;
  return "other";
}
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
  .replace(/\b(And|Of|The|To|Or)\b/g, (m) => m.toLowerCase());
const fmtDate = (ms) => new Date(ms).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

// ---------- address search (Vicmap Address) ----------

function parseAddress(text) {
  let s = text.toUpperCase().replace(/[,.]/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/\b(VIC|VICTORIA|AUSTRALIA)\b/g, " ").replace(/\s+/g, " ").trim();
  let postcode = null;
  const pc = s.match(/\s(3\d{3}|8\d{3})$/);
  if (pc) { postcode = pc[1]; s = s.slice(0, pc.index).trim(); }
  s = s.replace(/^(UNIT|APT|APARTMENT|SHOP|FLAT)\s+(\S+)\s+/, "$2/");
  const m = s.match(/^(?:(\w+)\s*\/\s*)?(\d+)([A-Z])?(?:\s*-\s*\d+[A-Z]?)?\s+(.+)$/);
  if (!m) return null;
  const [, unit, number, suffix, rest] = m;
  return { unit, number: Number(number), suffix, postcode, tokens: rest.split(" ") };
}

function addressWhere(p) {
  const options = [];
  // Try each split of "road words | locality words"; the road type is optional.
  for (let k = 1; k <= p.tokens.length; k++) {
    const road = p.tokens.slice(0, k);
    const locality = p.tokens.slice(k).join(" ");
    let type = null;
    if (road.length > 1 && ROAD_TYPES[road[road.length - 1]]) type = ROAD_TYPES[road.pop()];
    const parts = [`road_name=${sqlText(road.join(" "))}`];
    if (type) parts.push(`road_type=${sqlText(type)}`);
    if (locality) parts.push(`locality_name=${sqlText(locality)}`);
    else if (p.postcode) parts.push(`postcode=${sqlText(p.postcode)}`);
    else continue;
    options.push(`(${parts.join(" AND ")})`);
  }
  if (!options.length) return null;
  let where = `house_number_1=${p.number} AND (${options.join(" OR ")})`;
  if (p.suffix) where += ` AND house_suffix_1=${sqlText(p.suffix)}`;
  return where;
}

async function searchAddress(text) {
  const p = parseAddress(text);
  if (!p) throw new Error("Couldn't read that address. Try a street number, street and suburb, e.g. 1 Station Street Aspendale.");
  const where = addressWhere(p);
  if (!where) throw new Error("Add the suburb (or postcode) after the street name.");
  const data = await arcgisQuery(ADDRESS, {
    where, outFields: "ezi_address,blg_unit_id_1,house_suffix_1", outSR: 4326,
    returnGeometry: true, resultRecordCount: 100,
  });
  // Group units at the same spot; show the plainest label for each place.
  const groups = new Map();
  for (const f of data.features) {
    const key = `${f.geometry.x.toFixed(5)},${f.geometry.y.toFixed(5)}`;
    const label = f.attributes.ezi_address;
    const prev = groups.get(key);
    if (!prev || (prev.unit && !f.attributes.blg_unit_id_1) || label.length < prev.label.length) {
      groups.set(key, { label, unit: f.attributes.blg_unit_id_1, lng: f.geometry.x, lat: f.geometry.y });
    }
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// ---------- planning scheme API ----------

const normaliseLga = (s) => s.toUpperCase().replace(/\(UNINC\)/g, "").replace(/[^A-Z]+/g, " ").trim();

async function schemeForLga(lga) {
  const schemes = await cached("schemes", () => getJSON(`${SCHEME_API}/schemes/`));
  const target = normaliseLga(lga);
  return schemes.find((s) => s.state?.activeFlag && normaliseLga(s.title) === target) || null;
}

async function schemeNav(schemeID) {
  return cached(`nav:${schemeID}`, async () => {
    const data = await getJSON(`${SCHEME_API}/ordinance/scheme/${schemeID}/nav`);
    const entries = [];
    const walk = (nodes) => nodes.forEach((n) => { entries.push(n); if (n.children) walk(n.children); });
    walk(data.nav);
    const byCode = new Map();
    for (const e of entries) {
      for (const code of (e.ordinanceMapCode || "").split(",").map((c) => c.trim()).filter(Boolean)) {
        if (!byCode.has(code)) byCode.set(code, []);
        if (!byCode.get(code).some((x) => x.semanticNumber === e.semanticNumber)) byCode.get(code).push(e);
      }
    }
    return { amendment: data.amendmentNumber, gazetted: data.gazettalDate, byCode };
  });
}

function resolveClause(nav, code) {
  const fam = zoneFamily(code);
  const pick = (c, types) => (nav.byCode.get(c) || []).find((e) => types.includes(e.ordinanceType));
  const clause = pick(code, ["Clause", "Sub-Clause"]) || pick(fam, ["Clause", "Sub-Clause"]);
  const schedule = pick(code, ["Schedule"]) || (code === fam || /^HO\d/.test(code) ? pick(fam, ["Schedule"]) : null);
  return { clause, schedule };
}

function apiPath(semanticNumber) {
  // "32.08" -> "32/08"; "32.08-s3" -> "32/08/schedule/3"; "43.01-s" -> "43/01/schedule/s"
  const [num, sched] = semanticNumber.split("-s");
  const path = num.replace(".", "/");
  if (sched === undefined) return path;
  return `${path}/schedule/${sched || "s"}`;
}

async function ordinance(schemeID, semanticNumber) {
  return cached(`ord:${schemeID}:${semanticNumber}`, () =>
    getJSON(`${SCHEME_API}/ordinance/scheme/${schemeID}/${apiPath(semanticNumber)}`));
}

const parseHTML = (html) => new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html").body.firstChild;
const clean = (s) => s.replace(/\s+/g, " ").trim();

function purposeOf(doc) {
  const root = parseHTML(doc.content);
  const heading = [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")].find((h) => /^purpose/i.test(clean(h.textContent)));
  if (!heading) return [];
  const out = [];
  for (let n = heading.nextElementSibling; n && !/^H\d$/.test(n.tagName); n = n.nextElementSibling) {
    // Purposes are usually paragraphs, but newer clauses use a bulleted list.
    const items = /^(UL|OL)$/.test(n.tagName) ? [...n.querySelectorAll("li")] : [n];
    for (const item of items) {
      const t = clean(item.textContent);
      // Every zone and overlay starts with the same line about implementing the policy framework; skip it.
      if (t && !/^to implement the (municipal planning strategy|state planning policy framework)/i.test(t)) out.push(t);
    }
  }
  return out;
}

function scheduleSummary(doc) {
  const root = parseHTML(doc.content);
  const lines = [...root.querySelectorAll("p")].map((p) => clean(p.textContent))
    .filter((t) => t && !/^shown on the planning scheme map/i.test(t));
  return {
    heading: lines[0] && lines[0].length < 120 ? lines[0] : null,
    sections: (doc.sections || []).map((s) => clean(s.title)).filter(Boolean),
  };
}

function scheduleRow(doc, code) {
  // Heritage and similar overlays list every place in one table, keyed by its map reference.
  const html = (doc.content || "") + (doc.sections || []).map((s) => s.content || "").join("");
  const root = parseHTML(html);
  for (const table of root.querySelectorAll("table")) {
    let headers = [];
    for (const tr of table.querySelectorAll("tr")) {
      const cells = [...tr.children];
      if (cells.some((c) => c.tagName === "TH")) { headers = cells.map((c) => clean(c.textContent)); continue; }
      if (clean(cells[0]?.textContent || "") !== code) continue;
      const place = [...cells[1].querySelectorAll("p")].map((p) => clean(p.textContent)).filter(Boolean);
      const controls = cells.slice(2).map((c, i) => ({ label: headers[i + 2], value: clean(c.textContent) }))
        .filter((c) => c.label && /^yes/i.test(c.value));
      return { place, controls };
    }
  }
  return null;
}

// ---------- property and controls (Vicmap Property + Vicmap Planning) ----------

async function propertyAt(lng, lat) {
  const data = await arcgisQuery(PROPERTY, {
    geometry: `${lng},${lat}`, geometryType: "esriGeometryPoint", inSR: 4326,
    spatialRel: "esriSpatialRelIntersects", outFields: "prop_pfi", outSR: 4326,
    returnGeometry: true, resultRecordCount: 5, f: "geojson",
  });
  // Apartment blocks return one record per unit with the same footprint; any one will do.
  return data.features?.[0] || null;
}

function esriPolygon(feature) {
  const g = feature.geometry;
  const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
  return JSON.stringify({ rings: polys.flat(), spatialReference: { wkid: 4326 } });
}

function queryShape(parcel, lng, lat) {
  if (!parcel) {
    return { geometry: `${lng},${lat}`, geometryType: "esriGeometryPoint" };
  }
  // Shrink the lot slightly so zones that only touch its boundary aren't counted.
  let shape = parcel;
  try {
    const shrunk = turf.buffer(parcel, -0.75, { units: "meters" });
    if (shrunk && turf.area(shrunk) > 1) shape = shrunk;
  } catch (_) { /* keep the original lot */ }
  return { geometry: esriPolygon(shape), geometryType: "esriGeometryPolygon" };
}

async function controlsFor(shape, layer) {
  const base = {
    ...shape, inSR: 4326, outFields: "zone_code,zone_description,lga,gaz_begin_date",
    returnGeometry: false,
  };
  const [touching, whole] = await Promise.all([
    arcgisQuery(`${PLANNING}/${layer}`, { ...base, spatialRel: "esriSpatialRelIntersects" }),
    shape.geometryType === "esriGeometryPolygon"
      ? arcgisQuery(`${PLANNING}/${layer}`, { ...base, spatialRel: "esriSpatialRelWithin" })
      : Promise.resolve(null),
  ]);
  const wholeCodes = new Set((whole?.features || []).map((f) => f.attributes.zone_code));
  const byCode = new Map();
  for (const { attributes: a } of touching.features) {
    const prev = byCode.get(a.zone_code);
    if (!prev || a.gaz_begin_date > prev.since) {
      byCode.set(a.zone_code, {
        code: a.zone_code, description: a.zone_description.trim(), lga: a.lga, since: a.gaz_begin_date,
        extent: shape.geometryType === "esriGeometryPoint" ? "point" : wholeCodes.has(a.zone_code) ? "whole" : "part",
      });
    }
  }
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));
}

async function bushfireAt(shape) {
  const data = await arcgisQuery(`${PLANNING}/${LAYER.bushfire}`, {
    ...shape, inSR: 4326, spatialRel: "esriSpatialRelIntersects", returnCountOnly: true,
  });
  return data.count > 0;
}

// ---------- rendering ----------

function extentBadge(extent) {
  if (extent === "whole") return el("span", { class: "extent" }, "covers the whole lot");
  if (extent === "part") return el("span", { class: "extent partial" }, "covers part of the lot");
  return null;
}

function controlBlock(ctrl, scheme, kind) {
  const block = el("div", { class: "control", "data-code": ctrl.code });
  const swatch = kind === "zone" ? el("span", { class: "swatch", style: `background:${cssVar(`--z-${zoneGroup(ctrl.code)}`)}`, "aria-hidden": "true" }) : null;
  block.append(el("div", { class: "control-head" },
    swatch, el("span", { class: "name" }, titleCase(ctrl.description.replace(/\s*\([A-Z]+\d*\)\s*$/, ""))), el("span", { class: "code" }, ctrl.code),
    extentBadge(ctrl.extent)));
  const since = el("p", { class: "meta" }, `Mapped this way since ${fmtDate(ctrl.since)}`);
  block.append(since);
  const detail = el("div", { class: "detail" }, el("p", { class: "meta" }, "Loading clause…"));
  block.append(detail);
  fillControl(detail, ctrl, scheme).catch(() => {
    detail.replaceChildren(el("p", { class: "meta" }, "Couldn't load the clause text. ", scheme
      ? el("a", { href: `${SCHEME_SITE}/${encodeURIComponent(scheme.title)}/ordinance` }, "Open the planning scheme") : ""));
  });
  return block;
}

async function fillControl(detail, ctrl, scheme) {
  if (!scheme) {
    detail.replaceChildren(el("p", { class: "meta" }, "No planning scheme found for this area."));
    return;
  }
  const nav = await schemeNav(scheme.schemeID);
  const { clause, schedule } = resolveClause(nav, ctrl.code);
  const site = `${SCHEME_SITE}/${encodeURIComponent(scheme.title)}/ordinance`;
  const parts = [];
  const links = el("p", { class: "links" });

  if (clause) {
    const doc = await ordinance(scheme.schemeID, clause.semanticNumber);
    const purpose = purposeOf(doc);
    if (purpose.length) {
      const first = purpose.slice(0, 2);
      const rest = purpose.slice(2);
      const list = el("ul", {}, first.map((t) => el("li", {}, t)));
      const box = el("div", { class: "purpose" }, el("strong", {}, "Purpose"), list);
      if (rest.length) {
        box.append(el("details", {}, el("summary", {}, `${rest.length} more`), el("ul", {}, rest.map((t) => el("li", {}, t)))));
      }
      parts.push(box);
    }
    links.append(el("a", { href: `${site}/${clause.semanticNumber}` }, `Clause ${clause.semanticNumber}`));
  }

  if (schedule) {
    const doc = await ordinance(scheme.schemeID, schedule.semanticNumber);
    const row = /^HO\d/.test(ctrl.code) ? scheduleRow(doc, ctrl.code) : null;
    if (row) {
      const [name, address, ...notes] = row.place;
      const box = el("div", { class: "heritage" },
        el("strong", {}, "Heritage place: "), [name, address].filter(Boolean).join(", "),
        notes.map((n) => el("p", { class: "meta" }, n)));
      if (row.controls.length) {
        box.append(el("p", { class: "meta" }, "Extra controls that apply: ", row.controls.map((c) => c.label.replace(/\?$/, "")).join("; ")));
      }
      parts.push(box);
    } else {
      const s = scheduleSummary(doc);
      const bits = [];
      if (s.heading) bits.push(s.heading);
      if (s.sections.length) bits.push(`Sets local rules for: ${s.sections.join("; ")}`);
      if (bits.length) parts.push(el("p", { class: "schedule" }, bits.join(". ")));
    }
    links.append(el("a", { href: `${site}/${schedule.semanticNumber}` }, `Schedule ${schedule.semanticNumber.replace(/.*-s/, "") || ""} (local rules)`.replace(" ()", "")));
  }

  if (!clause && !schedule) {
    parts.push(el("p", { class: "meta" }, ctrl.code === "CA"
      ? "Commonwealth land: not controlled by the Victorian planning scheme."
      : "No matching clause found in the planning scheme index."));
  }
  if (links.childNodes.length) parts.push(links);
  detail.replaceChildren(...parts);
}

function renderResults({ label, scheme, nav, zones, overlays, bushfire, hasParcel }) {
  resultsEl.hidden = false;
  const council = zones[0]?.lga ? titleCase(zones[0].lga) : null;
  const head = [
    el("h2", {}, label),
    el("p", { class: "meta" },
      [council && `${council} Council`, scheme && nav && `${scheme.title} Planning Scheme, last amended ${nav.amendment} (${nav.gazetted})`]
        .filter(Boolean).join(" · ")),
  ];
  if (!hasParcel) head.push(el("p", { class: "meta" }, "No property boundary here, so results are for this exact point."));

  const zoneSec = [el("h3", {}, zones.length === 1 ? "Zone" : "Zones"),
    ...(zones.length ? zones.map((z) => controlBlock(z, scheme, "zone")) : [el("p", {}, "No zone found here.")])];
  const overlaySec = [el("h3", {}, "Overlays"),
    ...(overlays.length ? overlays.map((o) => controlBlock(o, scheme, "overlay")) : [el("p", {}, "No overlays apply.")])];
  const other = [el("h3", {}, "Also"),
    el("p", {}, bushfire ? "In a designated bushfire prone area (building rules apply)." : "Not in a designated bushfire prone area."),
    el("p", { class: "links" },
      el("a", { href: "https://mapshare.vic.gov.au/vicplan/" }, "Official property report (VicPlan)"),
      scheme && el("a", { href: `${SCHEME_SITE}/${encodeURIComponent(scheme.title)}/ordinance` }, `${scheme.title} Planning Scheme`))];
  resultsEl.replaceChildren(...head, ...zoneSec, ...overlaySec, ...other);
}

// ---------- map ----------

function prefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function initMap() {
  map = new maplibregl.Map({
    container: "map", style: prefersDark() ? STYLE_DARK : STYLE_LIGHT,
    center: START.center, zoom: START.zoom, attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.on("click", (e) => lookup(e.lngLat.lng, e.lngLat.lat, null));
  map.getCanvas().style.cursor = "crosshair";
}

function setSource(id, data) {
  const src = map.getSource(id);
  if (src) src.setData(data);
  else map.addSource(id, { type: "geojson", data });
}

async function drawContext(lng, lat, parcel, overlayCodes) {
  const ready = map.isStyleLoaded() ? Promise.resolve() : new Promise((r) => map.once("load", r));
  const d = 0.0035;
  const envelope = { xmin: lng - d, ymin: lat - d, xmax: lng + d, ymax: lat + d, spatialReference: { wkid: 4326 } };
  const common = {
    geometry: JSON.stringify(envelope), geometryType: "esriGeometryEnvelope", inSR: 4326,
    spatialRel: "esriSpatialRelIntersects", outFields: "zone_code", outSR: 4326,
    returnGeometry: true, maxAllowableOffset: 0.00001, geometryPrecision: 6, f: "geojson",
  };
  const [zonesGeo, overlaysGeo] = await Promise.all([
    arcgisQuery(`${PLANNING}/${LAYER.zones}`, { ...common, resultRecordCount: 400 }),
    overlayCodes.length
      ? arcgisQuery(`${PLANNING}/${LAYER.overlays}`, { ...common, where: `zone_code IN (${overlayCodes.map(sqlText).join(",")})` })
      : Promise.resolve({ type: "FeatureCollection", features: [] }),
  ]);
  for (const f of zonesGeo.features) f.properties.group = zoneGroup(f.properties.zone_code || "");
  await ready;

  const colour = ["match", ["get", "group"],
    ...Object.keys(ZONE_GROUPS).flatMap((g) => [g, cssVar(`--z-${g}`)]), cssVar("--z-other")];
  setSource("zones", zonesGeo);
  setSource("overlays", overlaysGeo);
  setSource("parcel", parcel || { type: "FeatureCollection", features: [] });
  setSource("point", { type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: {} });
  if (!map.getLayer("zones-fill")) {
    map.addLayer({ id: "zones-fill", type: "fill", source: "zones", paint: { "fill-color": colour, "fill-opacity": 0.55 } });
    map.addLayer({ id: "zones-line", type: "line", source: "zones", paint: { "line-color": colour, "line-width": 1 } });
    map.addLayer({ id: "overlays-line", type: "line", source: "overlays", paint: { "line-color": cssVar("--overlay"), "line-width": 1.5, "line-dasharray": [2, 2] } });
    map.addLayer({ id: "parcel-line", type: "line", source: "parcel", paint: { "line-color": cssVar("--parcel"), "line-width": 3 } });
    map.addLayer({ id: "point", type: "circle", source: "point", paint: { "circle-radius": 5, "circle-color": cssVar("--parcel"), "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  } else {
    map.setPaintProperty("zones-fill", "fill-color", colour);
  }
  if (parcel) {
    const [x1, y1, x2, y2] = turf.bbox(parcel);
    map.fitBounds([[x1, y1], [x2, y2]], { padding: 80, maxZoom: 18, duration: 600 });
  } else {
    map.easeTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 16), duration: 600 });
  }
}

// ---------- main flow ----------

async function lookup(lng, lat, label) {
  const seq = ++lookupSeq;
  choicesEl.hidden = true;
  setStatus("Looking up planning controls…");
  try {
    const parcel = await propertyAt(lng, lat);
    const shape = queryShape(parcel, lng, lat);
    const [zones, overlays, bushfire] = await Promise.all([
      controlsFor(shape, LAYER.zones), controlsFor(shape, LAYER.overlays), bushfireAt(shape),
    ]);
    if (seq !== lookupSeq) return;
    if (!zones.length && !overlays.length) {
      setStatus("No planning controls found here. Is this point in Victoria?", true);
      return;
    }
    const scheme = zones[0] ? await schemeForLga(zones[0].lga) : null;
    const nav = scheme ? await schemeNav(scheme.schemeID) : null;
    if (seq !== lookupSeq) return;
    renderResults({
      label: label || `Point ${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      scheme, nav, zones, overlays, bushfire, hasParcel: Boolean(parcel),
    });
    setStatus("");
    const url = new URL(location.href);
    url.search = label ? `?q=${encodeURIComponent(label)}` : `?at=${lat.toFixed(6)},${lng.toFixed(6)}`;
    history.replaceState(null, "", url);
    drawContext(lng, lat, parcel, overlays.map((o) => o.code)).catch(() => { /* map context is optional */ });
  } catch (err) {
    if (seq === lookupSeq) setStatus(`Something went wrong: ${err.message}. The government data services may be busy; try again.`, true);
  }
}

async function runSearch(text) {
  $("#q").value = text;
  choicesEl.hidden = true;
  setStatus("Finding the address…");
  try {
    const matches = await searchAddress(text);
    if (!matches.length) {
      setStatus("No matching address found. Include the street number, street name and suburb, e.g. 1 Station Street Aspendale.", true);
      return;
    }
    if (matches.length === 1) {
      lookup(matches[0].lng, matches[0].lat, titleCase(matches[0].label));
      return;
    }
    setStatus(`${matches.length} matches. Pick one:`);
    choicesEl.replaceChildren(...matches.slice(0, 12).map((m) => el("li", {},
      Object.assign(el("button", { type: "button" }, titleCase(m.label)), {
        onclick: () => lookup(m.lng, m.lat, titleCase(m.label)),
      }))));
    choicesEl.hidden = false;
  } catch (err) {
    setStatus(err.message.startsWith("Couldn't") || err.message.startsWith("Add the")
      ? err.message : `Address search failed: ${err.message}. Try again in a moment.`, true);
  }
}

function init() {
  initMap();
  $("#search").addEventListener("submit", (e) => { e.preventDefault(); runSearch($("#q").value); });
  for (const b of document.querySelectorAll("#examples button")) b.addEventListener("click", () => runSearch(b.dataset.q));
  const params = new URLSearchParams(location.search);
  if (params.get("q")) runSearch(params.get("q"));
  else if (params.get("at")) {
    const [lat, lng] = params.get("at").split(",").map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng)) lookup(lng, lat, null);
  }
}

init();
