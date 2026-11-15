# Créditos y referencias

Todo dato, código o librería ajena que usa el proyecto. Se mantiene al día con cada cambio.

## Datos de NASA

| Dato | Misión | Fuente | Uso |
|---|---|---|---|
| Modelo de terreno HiRISE DTEEC_019698_1750_019988_1750_U01 | Mars Reconnaissance Orbiter | USGS Astrogeology, Analysis Ready Data: https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/hirise/controlled/dtm/ | Relieve, pendiente y rugosidad de la zona de salida |
| Ortoimagen HiRISE ESP_019698_1750_RED_A_01 | Mars Reconnaissance Orbiter | Ídem | Imagen de fondo de la zona |
| Recorrido y paradas de Curiosity | Mars Science Laboratory | NASA/JPL MMGIS: https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/ | Centro de la zona y comparación con la ruta real |
| Fotos Navcam con modelo de cámara CAHVOR y orientación del rover (12 paradas, soles 4916–5040) | Mars Science Laboratory | API pública de imágenes crudas de NASA: https://mars.nasa.gov/api/v1/raw_image_items/ (NASA/JPL-Caltech) | Horizonte medido para la localización a ciegas y fotos desde el suelo |
| Relieve sombreado en color MOLA + HRSC (200 m/px) | Mars Global Surveyor, Mars Express (ESA) | JPL Mars Trek, capa `Mars_MOLA_blend200ppx_HRSC_ClrShade_clon0dd_200mpp_lzw` | Fondo de la vista de todo Marte |
| Exploration Zones (NASA EMC) | Taller de NASA de 2015 sobre sitios para misiones humanas | JPL Mars Trek, servicio `EZMars` | 48 zonas candidatas en la vista de Marte |
| Relieve global MOLA + HRSC, 200 m (`Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2`) | Mars Global Surveyor, Mars Express (ESA) | USGS Astrogeology: https://planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/ | Relieve y pendiente de las regiones (rutas en rover) |
| THEMIS infrarrojo diurno, 100 m | Mars Odyssey | JPL Mars Trek, capa `THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018` | Imagen de cada región (dato térmico) |
| THEMIS infrarrojo nocturno, 100 m | Mars Odyssey | JPL Mars Trek, capa `THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018` | Capa térmica de la zona de caminata y suelo blando probable |
| CRISM MTRDR, productos resumen HYD y PHY (7 observaciones: FRT000058A3, FRT0000B6F1, HRL0000BABA, HRL0001233B, FRT0001BBA1, FRT0001CA91, FRT00021C92) | Mars Reconnaissance Orbiter | PDS Geosciences Node, Orbital Data Explorer: https://ode.rsl.wustl.edu/mars/ | Minerales con agua y arcillas en la zona de caminata |
| Partes del tiempo de Curiosity (REMS): temperatura, presión, UV, opacidad, salida y puesta del sol | Mars Science Laboratory (instrumento REMS, CAB/INTA) | NASA, feed público de clima de Curiosity | Ventana EVA, validación de la posición del Sol, presión de referencia del barómetro |
| Clima espacial: eyecciones solares con llegada a Marte (WSA-ENLIL) y partículas solares (SEP) | NASA CCMC / M2M | DONKI: https://api.nasa.gov (DONKI) | Semáforo de la Ventana EVA |

## Recursos del reto

| Recurso | Uso |
|---|---|
| JPL Mars Trek (https://trek.nasa.gov/mars/) | Fondo de Marte, las 48 zonas candidatas, imagen THEMIS de cada región y térmico nocturno de la zona de caminata |

## Parámetros con fuente

| Parámetro | Fuente |
|---|---|
| Pendiente máxima a pie: 20° de capacidad del traje menos el margen medido (~14°) | Artemis xEVA ConOps EVA-EXP-0042 y EVA Ops 101 (NTRS); margen medido por el equipo contra 508 paradas de Curiosity |
| Regreso de emergencia ≤ 60 min, ingreso 10 min, rescate ≤ 60 min, 8 h + 1 h de consumibles | xEVA ConOps EVA-EXP-0042 Rev B (NTRS 20205008200), EHP-10028 (NTRS 20240009010) |
| Colchón del 20 % en el regreso a pie | Límite de walkback de Apollo 15 |
| Regreso a pie ≤ 5 h si falla el rover | xEVA ConOps EVA-EXP-0042 |
| Velocidad de ~2 km/h en plano | EVA Ops 101 para Artemis III (NTRS 20240005248) |
| Rescate: arrastre a 50 % de la velocidad y pendiente ≤ 10° | Propuesta del equipo (sin datos medidos en gravedad marciana) |
| Todas las reglas y su detalle | `config/riesgo.json` y `reports/Gestión de riesgo en salidas marcianas.md` |
| Función de velocidad según la pendiente | Tobler 1993 (a calibrar con Apollo) |
| Límites y velocidad del rover | Propuestas del equipo, a calibrar (`config/rover.json`) |
| Lado de 200 km de cada región | Definición de Exploration Zone: ~100 km alrededor del sitio (NASA, 2015) |
| Productos resumen de CRISM (SINDEX2, BD2100_2, BD1900_2, D2300, D2200, BD1900R2) | Viviano-Beck et al. (2014), JGR Planets 119, 1403–1431 |
| Posición del Sol, hora solar y estación | Algoritmo Mars24 (Allison y McEwen 2000; NASA GISS); validado contra 700 salidas y puestas del sol de REMS (error medio 0,6 min) |
| Ecuación hipsométrica para el barómetro: R = 192,1 J/(kg·K), g = 3,71 m/s² | NASA Glenn «Mars Atmosphere Model»; ESA. Ruido de presión 1 Pa y de temperatura 2 K: propuestas a calibrar |
| Suelo blando: el 20 % más oscuro de noche y liso (≤ 10 cm) | Propuesta del equipo, a calibrar (`config/capas_extra.json`) |
| Radio: antena 3 m, traje 1,8 m, alcance 5 km, ≤ 2 min sin enlace | Propuestas del equipo, a calibrar (`config/radio.json`) |
| Expediciones: alejamiento ≤ 12 km con un rover presurizado y ≤ 100 km con dos; autonomía ~100 km | xEVA ConOps EVA-EXP-0042 y estudios de arquitectura de NASA (verificado parcial); velocidad, horas de manejo, reserva y depósitos son propuestas (`config/expedicion.json`) |
| Largo del paso: 0,7 m | Propuesta, a calibrar: el paso en 0,38 g no está medido |
| Necesidades por persona y día en un refugio (oxígeno, agua, comida, energía) | NASA BVAD, Baseline Values and Assumptions Document (NTRS 20210024855) |
| Metabolismo promedio en EVA: ~234 kcal/h | Datos de EVA de Apollo (NTRS 19930074290); su adaptación a 0,38 g y al traje marciano es propuesta, a calibrar |
| Capacidades del traje, inventarios típicos de refugios y depósitos, refugio mínimo de 24 h | Propuestas del equipo, a calibrar (`config/consumibles.json`) |
| Tasas de falla para la probabilidad de completar y de volver a salvo | Propuestas del equipo, a calibrar (`config/confiabilidad.json`): sirven para comparar rutas, no son probabilidades medidas |
| Incertidumbre de posición de 25 m (95 %) | Medición propia: ubicación a ciegas con fotos de Curiosity en 12 paradas |
| Plazo de 30 min para entrar a un refugio ante partículas solares | Propuesta del equipo, a calibrar |

## Identidad

| Elemento | Fuente |
|---|---|
| Insignia «Insignia Marciana — Frontera Roja» | Equipo Red Frontier PDE (ficha del equipo en Space Apps); recortada en círculo para la app |
| Paleta de la app | Colores de la insignia del equipo (#E52918, #F74F25, #AE1C13, #100F11) |

## Librerías

| Librería | Licencia | Uso |
|---|---|---|
| NumPy | BSD-3-Clause | Cálculo numérico del pipeline |
| SciPy | BSD-3-Clause | Filtros de rugosidad |
| rasterio / GDAL | BSD-3-Clause / MIT | Lectura y remuestreo de los datos de NASA |
| Pillow | MIT-CMU (HPND) | Ortoimagen y fondo global en JPEG |
| Leaflet 1.9.4 | BSD-2-Clause | Mapa interactivo (copia local en `app/vendor/leaflet`) |

## Uso de IA / AI use

Se usaron herramientas de IA para traducir la interfaz al inglés, como guía para buscar y resumir fuentes de
investigación de NASA, y como asistente de programación en partes del código, las pruebas y los textos. El equipo
definió el alcance, revisó y probó los resultados. Los datos observados provienen de las fuentes citadas arriba.

AI tools were used to translate the interface into English, as a guide to find and summarize NASA research
sources, and as a programming assistant for parts of the code, tests and texts. The team defined the scope and
reviewed and tested the results. Observed data come from the sources cited above.
