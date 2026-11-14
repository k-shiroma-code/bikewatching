// Import Mapbox and D3 as ESM modules
import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// Check that Mapbox GL JS is loaded
console.log('Mapbox GL JS Loaded:', mapboxgl);

// ===== Step 1.3: create the map =====
// Paste your default public token (starts with "pk.") from https://account.mapbox.com/
mapboxgl.accessToken = 'pk.eyJ1Ijoia3NzaGlyb21hIiwiYSI6ImNtd2ZybWY5eTBiNHozMHExamF0ZjF1eHEifQ.zrgLZRj_6vhmjEKDQdNlQg';

const map = new mapboxgl.Map({
  container: 'map', // ID of the div where the map will render
  style: 'mapbox://styles/mapbox/light-v11', // A quiet basemap so the data stands out
  center: [-71.09415, 42.36027], // [longitude, latitude]
  zoom: 12, // Initial zoom level
  minZoom: 5, // Minimum allowed zoom
  maxZoom: 18, // Maximum allowed zoom
});

// ===== Step 2.2: one shared style for both cities' bike lanes =====
const bikeLaneStyle = {
  'line-color': '#32D400',
  'line-width': 3,
  'line-opacity': 0.5,
};

// ===== Step 3.3: project station lon/lat to pixel coordinates on the map =====
function getCoords(station) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

// ===== Step 5.2: slider minutes → "8:30 AM" =====
function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString('en-US', { timeStyle: 'short' });
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// ===== Step 5.4: trips pre-sorted into one bucket per minute of the day =====
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute = Array.from({ length: 1440 }, () => []);

function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) {
    return tripsByMinute.flat(); // No filtering, return all trips
  }

  // Normalize both min and max minutes to the valid range [0, 1439]
  let minMinute = (minute - 60 + 1440) % 1440;
  let maxMinute = (minute + 60) % 1440;

  // Handle time filtering across midnight
  if (minMinute > maxMinute) {
    let beforeMidnight = tripsByMinute.slice(minMinute);
    let afterMidnight = tripsByMinute.slice(0, maxMinute);
    return beforeMidnight.concat(afterMidnight).flat();
  } else {
    return tripsByMinute.slice(minMinute, maxMinute).flat();
  }
}

// ===== Step 4.2 / 5.3: arrivals, departures and total traffic per station =====
function computeStationTraffic(stations, timeFilter = -1) {
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    (v) => v.length,
    (d) => d.start_station_id,
  );

  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    (v) => v.length,
    (d) => d.end_station_id,
  );

  return stations.map((station) => {
    let id = station.short_name;
    station.arrivals = arrivals.get(id) ?? 0;
    station.departures = departures.get(id) ?? 0;
    station.totalTraffic = station.arrivals + station.departures;
    return station;
  });
}

// ===== Step 6.1: 3 colors — mostly departures, balanced, mostly arrivals =====
const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

function departureRatio(station) {
  // A station with no trips in the window counts as balanced rather than NaN
  return station.totalTraffic === 0 ? 0.5 : stationFlow(station.departures / station.totalTraffic);
}

function tooltipText(d) {
  return `${d.name}\n${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`;
}

map.on('load', async () => {
  // ===== Step 2: bike lanes =====
  map.addSource('boston_route', {
    type: 'geojson',
    data: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson',
  });
  map.addLayer({ id: 'bike-lanes', type: 'line', source: 'boston_route', paint: bikeLaneStyle });

  map.addSource('cambridge_route', {
    type: 'geojson',
    data: 'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson',
  });
  map.addLayer({ id: 'cambridge-bike-lanes', type: 'line', source: 'cambridge_route', paint: bikeLaneStyle });

  const status = document.getElementById('status');

  // ===== Step 3.1 / 4.1: load stations and trips =====
  let jsonData;
  let trips;
  try {
    jsonData = await d3.json('https://dsc106.com/labs/lab07/data/bluebikes-stations.json');

    trips = await d3.csv('https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv', (trip) => {
      // "2024-03-20 08:18:13" → ISO with a "T", which every browser parses as local time
      trip.started_at = new Date(trip.started_at.replace(' ', 'T'));
      trip.ended_at = new Date(trip.ended_at.replace(' ', 'T'));

      departuresByMinute[minutesSinceMidnight(trip.started_at)].push(trip);
      arrivalsByMinute[minutesSinceMidnight(trip.ended_at)].push(trip);
      return trip;
    });
  } catch (error) {
    console.error('Error loading data:', error);
    status.textContent = 'Could not load the Bluebikes data.';
    return;
  }

  const stations = computeStationTraffic(jsonData.data.stations);
  status.textContent = '';

  // ===== Step 4.3: circle area ∝ traffic =====
  const radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stations, (d) => d.totalTraffic)])
    .range([0, 25]);

  // ===== Step 3.3: one circle per station, keyed by station id =====
  const svg = d3.select('#map').select('svg');

  const circles = svg
    .selectAll('circle')
    .data(stations, (d) => d.short_name)
    .enter()
    .append('circle')
    .attr('r', (d) => radiusScale(d.totalTraffic))
    .style('--departure-ratio', (d) => departureRatio(d))
    .each(function (d) {
      // ===== Step 4.4: browser tooltip with exact numbers =====
      d3.select(this).append('title').text(tooltipText(d));
    });

  function updatePositions() {
    circles
      .attr('cx', (d) => getCoords(d).cx)
      .attr('cy', (d) => getCoords(d).cy);
  }

  updatePositions();

  // Keep markers aligned with the map
  map.on('move', updatePositions);
  map.on('zoom', updatePositions);
  map.on('resize', updatePositions);
  map.on('moveend', updatePositions);

  // ===== Step 5.2–5.3: time slider =====
  const timeSlider = document.getElementById('time-slider');
  const selectedTime = document.getElementById('selected-time');
  const anyTimeLabel = document.getElementById('any-time');

  function updateScatterPlot(timeFilter) {
    const filteredStations = computeStationTraffic(stations, timeFilter);

    // Fewer trips when filtering, so allow bigger circles to keep stations visible
    timeFilter === -1 ? radiusScale.range([0, 25]) : radiusScale.range([3, 50]);

    circles
      .data(filteredStations, (d) => d.short_name)
      .join('circle')
      .attr('r', (d) => radiusScale(d.totalTraffic))
      .style('--departure-ratio', (d) => departureRatio(d))
      .select('title')
      .text((d) => tooltipText(d));
  }

  function updateTimeDisplay() {
    let timeFilter = Number(timeSlider.value);

    if (timeFilter === -1) {
      selectedTime.textContent = '';
      anyTimeLabel.style.display = 'block';
    } else {
      selectedTime.textContent = formatTime(timeFilter);
      anyTimeLabel.style.display = 'none';
    }

    updateScatterPlot(timeFilter);
  }

  timeSlider.addEventListener('input', updateTimeDisplay);
  updateTimeDisplay();
});
