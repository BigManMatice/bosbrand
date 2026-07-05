Brandkaart Zuid-Frankrijk — multi-source versie

Bestanden:
- index.html
- styles.css
- app.js

Open index.html in een browser. De app werkt mobiel en desktop, met licht/donker-modus.

Bronnen in de app:
1. Gecurateerde, brongecontroleerde branden in Zuid-Frankrijk:
   - Aude: Pouzols-Minervois / Minervois
   - Aude: Narbonne
   - Pyrénées-Orientales: Trévillach / Tarérach / Montalba-le-Château
   - Pyrénées-Orientales: Sainte-Marie-la-Mer / Canet-en-Roussillon
   - Gard: Rochefort-du-Gard / A9
   - Drôme: Die / massif de Justin
   - Bouches-du-Rhône: Lançon-Provence
   - Hérault/Aude: Oupia richting Minervois
   - Aude: Ginestas

2. NASA FIRMS:
   - VIIRS_SNPP_NRT
   - VIIRS_NOAA20_NRT
   - MODIS_NRT

3. Open-Meteo:
   - windrichting
   - windsnelheid
   - windstoten
   - temperatuur
   - luchtvochtigheid

4. Feux de Forêt en GDELT:
   - recente meldingen en nieuwscontrole

Belangrijk:
- NASA FIRMS toont hittepunten, geen officiële brandgrenzen.
- De oranje cirkel is een geschatte zone. Bij officiële/gemelde branden wordt de straal berekend uit de gemelde hectares. Bij NASA-zones wordt de straal berekend uit gegroepeerde hotspots.
- Gebruik deze kaart niet als evacuatie- of veiligheidsinstructie. Volg altijd prefectuur, brandweer/SDIS, gemeente en 112.

Onderhoud:
- De lijst met brongecontroleerde branden staat in app.js in getOfficialSouthernFranceFires().
- Update daar de status, hectares en links wanneer nieuwe officiële points de situation verschijnen.

Update: geselecteerde brandoppervlakte op de kaart
- Wanneer je een brand selecteert, verschijnt nu direct in de cirkel op de kaart een label met de totale geschatte oppervlakte.
- Voor officiële/gemelde branden gebruikt de kaart de gerapporteerde hectares, bijvoorbeeld 900 ha.
- Voor alleen NASA-zones berekent de kaart een geschatte oppervlakte uit de gegroepeerde hittepunten.
