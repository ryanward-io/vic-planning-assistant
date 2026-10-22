# Victorian planning lookup

Enter a Victorian address (or click the map) to see the planning zones and overlays that apply to the lot, what each one is for, and links to the exact planning scheme clauses and local schedules.

**Live:** https://ryanward.dev/vic-planning-assistant/

This is milestone 1 of a larger project: a planning assistant that answers questions about a property in plain English, cites the clauses, and is measured against a hand-checked evaluation set. Milestone 1 uses no language model at all. Everything on the page comes straight from official open data, so it can't make anything up.

## How it works

The page is static (GitHub Pages) and calls the government services directly from the browser. There is no backend and it costs nothing to run.

1. **Address → point.** The address is split into number, street and suburb and matched against Vicmap Address.
2. **Point → lot.** The lot boundary comes from Vicmap Property.
3. **Lot → controls.** Zones, overlays and the bushfire prone area come from Vicmap Planning. The lot is shrunk by 0.75 m first, so zones that only touch its edge aren't counted, and each control is marked as covering the whole lot or only part of it.
4. **Controls → clauses.** The planning scheme API maps each code (for example `GRZ3`) to its clause and schedule. The page shows the clause's stated purpose, what the local schedule sets rules for and, for heritage overlays, the listed heritage place and any extra controls.

The map uses MapLibre with OpenFreeMap tiles, and Turf for the lot geometry.

## Limits

- Not legal advice. It shows which controls apply, not whether a permit is needed for a particular proposal; that depends on the detail of the clauses, particular provisions, and the proposal itself. Use an official [VicPlan planning property report](https://www.planning.vic.gov.au/planning-schemes/using-vicplan) or ask the council.
- Address search needs a street number, street name and suburb (or postcode). It doesn't autocomplete.
- It depends on the state's services being up; if one is slow or down, the page says so.

## Data and licences

- Vicmap Planning, Vicmap Address and Vicmap Property: © State of Victoria (Department of Transport and Planning), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Clause text is quoted from the [Victorian planning schemes](https://planning-schemes.app.planning.vic.gov.au/) and linked back to the source.
- Map tiles: © [OpenFreeMap](https://openfreemap.org), © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
- Code: MIT (see `LICENSE`).

## Running locally

Any static server works, for example:

```sh
python3 -m http.server 8000
```

then open http://localhost:8000/.
