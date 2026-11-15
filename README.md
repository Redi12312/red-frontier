# Red Frontier — Explore and plan on Mars

[Open the app in English](https://redi12312.github.io/red-frontier/app/?lang=en) · [Abrí la app en español](https://redi12312.github.io/red-frontier/app/?lang=es) · [Demo slides (PDF)](https://redi12312.github.io/red-frontier/RedFrontier_demo.pdf)

NASA Space Apps Challenge 2026 · *Interplanetary Survival Guide: Martian Map*  
Red Frontier PDE · Punta del Este, Uruguay

Red Frontier is a prototype for exploring how a crew could travel on Mars and return to shelter. It combines NASA and USGS observations with models of travel time, equipment and resources. The interface and built-in guide are available in English and Spanish.

Explore a detailed walking map of Mount Sharp in Gale crater, or plan rover traverses in 48 candidate exploration regions. Place planned habitats and refuges, compare routes, inspect return and rescue checks, and rehearse equipment failures in a simulated visor. Radio, shadows and skyline matching help explain how terrain affects a plan.

## Try it

1. Open the app, choose your language and open **Guide** for explanations and actions you can try.
2. Open the walking map of **Gale** and press **Load example mission: Mount Sharp boxwork**: a habitat and a science stop on the boxwork ridges (minerals left by ancient groundwater), placed at real Curiosity stops, with the itinerary computed and approved. Or right-click valid terrain to set your own base and destination.
3. Calculate a route and read its **GO / NO-GO** checks. Each check shows the value, limit and source used by the model.
4. Start the route simulation and inject a suit leak or solar storm. Watch the return path, remaining resources and verdict change.
5. Try the geolocation panel with the supplied Curiosity photos, or use the map menu to inspect radio coverage and shadows. Export your plan as GeoJSON to keep a separate copy.

## Run a downloaded copy

Download the [published repository](https://github.com/Redi12312/red-frontier), open a terminal in its root folder and run:

```sh
python -m http.server 8000
```

Open [the local app](http://127.0.0.1:8000/app/?lang=en). If you are working from the source project containing `proyecto/`, run `python proyecto/servidor.py` from the source root instead and open [the source app](http://127.0.0.1:8770/app/?lang=en).

Keep the app, zone data, photos and camera metadata on your device before disconnecting. Map and route calculations then run locally. Updating weather or retrieving missing photo metadata needs internet. The hosted site does not guarantee an offline reload. Plans save in the browser; the source project's local server also saves to a project file once the write completes.

## Data and credits

The walking map uses a HiRISE terrain model processed onto a 2 m grid. Regional relief comes from MOLA–HRSC. Other observations include THEMIS infrared imagery, CRISM mineral products, Curiosity's traverse and Navcam photos, REMS weather reports and DONKI space-weather records. The app shows the dates of stored weather reports.

These observations are real. Routes, radio coverage, shadows and position estimates are calculated. Human bases, suit resources and injected failures are planned or simulated. Parameters and their sources are documented in `config/`; proposed values require calibration. See [CREDITOS.md](CREDITOS.md) for data sources, software credits and licenses.

## Limits

- This is a planning and learning prototype. Human equipment, resource use and failure rates need validation for Mars; a green result is a model result, not a safety guarantee.
- Terrain detail and coverage vary by product. Soft-soil estimates indicate possible hazards; radio visibility does not establish a working communications link.
- Probabilities compare plans under proposed assumptions. They do not cover every failure, and long rover expeditions do not budget overnight life support.
- Skyline matching needs visible, distinctive terrain and valid camera metadata. A stored test on 12 Curiosity stops gave 20.1 m median error; 9 results fell inside their reported intervals. Position uncertainty still needs calibration.
- Weather reports may be old. The model does not automatically reject a plan because of report age, and it does not verify shelter radiation shielding.

Red Frontier is an independent project and has no NASA endorsement.
