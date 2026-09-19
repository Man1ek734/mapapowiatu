const CONFIG = {
  center: [50.805, 21.425],
  zoom: 10,
  overpass: [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.nchc.org.tw/api/interpreter"
  ]
};

const META = {
  food:        { label: "Gastronomia", icon: "🍴" },
  attractions: { label: "Zabytki i atrakcje", icon: "🏛️" },
  lodging:     { label: "Noclegi", icon: "🛏️" },
  cycling:     { label: "Trasy rowerowe", icon: "🚴" },
  recreation:  { label: "Sport i rekreacja", icon: "🌳" },
  health:      { label: "Zdrowie", icon: "🏥" },
  transport:   { label: "Transport i parkingi", icon: "🚌" },
  public:      { label: "Urzędy i usługi", icon: "🏢" },
  shopping:    { label: "Zakupy", icon: "🛍️" }
};

const map = L.map("map", { zoomControl: true, preferCanvas: true }).setView(CONFIG.center, CONFIG.zoom);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

const layers = {};
Object.keys(META).forEach(key => {
  layers[key] = L.layerGroup().addTo(map);
});

let boundaryLayer = null;
let items = [];
let routes = [];
let userMarker = null;

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[char]));
}

function categoryFor(tags = {}) {
  const amenity = tags.amenity || "";
  const tourism = tags.tourism || "";
  const leisure = tags.leisure || "";

  if (tags.route === "bicycle") return "cycling";
  if (/restaurant|cafe|fast_food|bar|pub|ice_cream|food_court/.test(amenity)) return "food";
  if (/hotel|guest_house|hostel|motel|camp_site|caravan_site|chalet|apartment/.test(tourism)) return "lodging";
  if (tags.historic || /attraction|museum|gallery|viewpoint|information/.test(tourism)) return "attractions";
  if (/park|playground|sports_centre|pitch|swimming_pool|nature_reserve|fitness_centre|stadium/.test(leisure) || tags.natural === "peak") return "recreation";
  if (/hospital|clinic|doctors|pharmacy|dentist|veterinary/.test(amenity)) return "health";
  if (/parking|bus_station|taxi|charging_station|fuel/.test(amenity) || tags.highway === "bus_stop" || tags.public_transport) return "transport";
  if (/townhall|police|fire_station|post_office|library|community_centre|courthouse|social_facility/.test(amenity) || tags.office === "government") return "public";
  if (tags.shop) return "shopping";
  return null;
}

function getName(tags = {}, category) {
  return tags["name:pl"] || tags.name || tags.brand || tags.operator || META[category].label;
}

function getAddress(tags = {}) {
  const line1 = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ");
  const line2 = [tags["addr:postcode"], tags["addr:city"]].filter(Boolean).join(" ");
  return [line1, line2].filter(Boolean).join(", ");
}

function makeIcon(category) {
  return L.divIcon({
    className: "",
    html: '<div class="marker-pin">' + META[category].icon + "</div>",
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -16]
  });
}

function popupHtml(item) {
  const t = item.tags;
  const addr = getAddress(t);
  const phone = t["contact:phone"] || t.phone;
  const website = t["contact:website"] || t.website || t.url;
  const osmUrl = "https://www.openstreetmap.org/" + item.type + "/" + item.id;
  const directions = "https://www.openstreetmap.org/directions?to=" + item.lat + "%2C" + item.lon;

  let html = '<div class="popup-cat">' + escapeHtml(META[item.category].label) + "</div>";
  html += '<div class="popup-title">' + escapeHtml(item.name) + "</div>";
  if (addr) html += '<div class="popup-row">📍 ' + escapeHtml(addr) + "</div>";
  if (t.opening_hours) html += '<div class="popup-row">🕒 ' + escapeHtml(t.opening_hours) + "</div>";
  if (phone) html += '<div class="popup-row">☎ ' + escapeHtml(phone) + "</div>";
  html += '<div class="popup-actions">';
  html += '<a href="' + osmUrl + '" target="_blank" rel="noopener">OpenStreetMap</a>';
  html += '<a class="alt" href="' + directions + '" target="_blank" rel="noopener">Wyznacz trasę</a>';
  if (website) html += '<a class="alt" href="' + escapeHtml(website) + '" target="_blank" rel="noopener">Strona WWW</a>';
  html += "</div>";
  return html;
}

function addPlace(element) {
  const category = categoryFor(element.tags);
  if (!category || category === "cycling") return;

  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  const item = {
    id: element.id,
    type: element.type,
    tags: element.tags || {},
    category,
    lat,
    lon,
    name: getName(element.tags || {}, category)
  };

  item.marker = L.marker([lat, lon], { icon: makeIcon(category), riseOnHover: true })
    .bindPopup(popupHtml(item));

  item.marker.addTo(layers[category]);
  items.push(item);
}

function routePopup(tags = {}) {
  const name = getName(tags, "cycling");
  const network = tags.network ? "<div class='popup-row'>Sieć: " + escapeHtml(tags.network) + "</div>" : "";
  const ref = tags.ref ? "<div class='popup-row'>Oznaczenie: " + escapeHtml(tags.ref) + "</div>" : "";
  return "<div class='popup-cat'>Trasa rowerowa</div><div class='popup-title'>" +
    escapeHtml(name) + "</div>" + network + ref;
}

function addRoute(element, index) {
  const segments = [];
  (element.members || []).forEach(member => {
    if (member.geometry?.length > 1) {
      segments.push(member.geometry.map(p => [p.lat, p.lon]));
    }
  });
  if (!segments.length && element.geometry?.length > 1) {
    segments.push(element.geometry.map(p => [p.lat, p.lon]));
  }
  if (!segments.length) return;

  const palette = ["#2574db", "#168a5c", "#d57a12", "#7c4dc4", "#c2415b"];
  const group = L.layerGroup();
  segments.forEach(segment => {
    L.polyline(segment, {
      color: palette[index % palette.length],
      weight: 5,
      opacity: .82,
      lineCap: "round"
    }).bindPopup(routePopup(element.tags || {})).addTo(group);
  });
  group.addTo(layers.cycling);
  routes.push({
    id: element.id,
    name: getName(element.tags || {}, "cycling"),
    layer: group,
    tags: element.tags || {}
  });
}

async function overpass(query) {
  let lastError;
  for (const endpoint of CONFIG.overpass) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: "data=" + encodeURIComponent(query)
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Nie udało się pobrać danych mapy.");
}

const placesQuery = `
[out:json][timeout:55];
area["boundary"="administrative"]["admin_level"="6"]["name"~"opatowski",i]->.searchArea;
(
  nwr(area.searchArea)["amenity"~"restaurant|cafe|fast_food|bar|pub|ice_cream|food_court|hospital|clinic|doctors|pharmacy|dentist|veterinary|parking|bus_station|taxi|charging_station|fuel|townhall|police|fire_station|post_office|library|community_centre|courthouse|social_facility"];
  nwr(area.searchArea)["tourism"~"attraction|museum|gallery|viewpoint|information|hotel|guest_house|hostel|motel|camp_site|caravan_site|chalet|apartment"];
  nwr(area.searchArea)["historic"];
  nwr(area.searchArea)["leisure"~"park|playground|sports_centre|pitch|swimming_pool|nature_reserve|fitness_centre|stadium"];
  nwr(area.searchArea)["highway"="bus_stop"];
  nwr(area.searchArea)["public_transport"];
  nwr(area.searchArea)["office"="government"];
  nwr(area.searchArea)["natural"="peak"];
  nwr(area.searchArea)["shop"];
  rel(area.searchArea)["route"="bicycle"];
);
out body center geom;
`;

const boundaryQuery = `
[out:json][timeout:30];
rel["boundary"="administrative"]["admin_level"="6"]["name"~"opatowski",i];
out geom;
`;

function drawBoundary(data) {
  const relation = (data.elements || []).find(e => e.type === "relation");
  if (!relation) return;

  const lines = [];
  (relation.members || []).forEach(member => {
    if (member.geometry?.length > 1) {
      lines.push(member.geometry.map(p => [p.lat, p.lon]));
    }
  });

  if (!lines.length) return;
  boundaryLayer = L.polyline(lines, {
    color: "#0b5d3b",
    weight: 3,
    opacity: .85,
    dashArray: "8 7",
    interactive: false
  }).addTo(map);

  try {
    map.fitBounds(boundaryLayer.getBounds(), { padding: [24, 24] });
  } catch (_) {}
}

function updateCounts() {
  Object.keys(META).forEach(category => {
    const count = category === "cycling"
      ? routes.length
      : items.filter(item => item.category === category).length;
    const el = document.querySelector('[data-count="' + category + '"]');
    if (el) el.textContent = count;
  });
}

function isActive(category) {
  return document.querySelector('[data-category="' + category + '"]')?.classList.contains("active");
}

function applyFilters() {
  const query = $("#searchInput").value.trim().toLowerCase();

  items.forEach(item => {
    const haystack = (item.name + " " + JSON.stringify(item.tags)).toLowerCase();
    const shouldShow = isActive(item.category) && (!query || haystack.includes(query));
    const layer = layers[item.category];

    if (shouldShow && !layer.hasLayer(item.marker)) layer.addLayer(item.marker);
    if (!shouldShow && layer.hasLayer(item.marker)) layer.removeLayer(item.marker);
  });

  if (isActive("cycling")) {
    if (!map.hasLayer(layers.cycling)) map.addLayer(layers.cycling);
  } else if (map.hasLayer(layers.cycling)) {
    map.removeLayer(layers.cycling);
  }

  renderResults(query);
}

function renderResults(query = "") {
  const visible = items.filter(item => {
    const layer = layers[item.category];
    return map.hasLayer(layer) && layer.hasLayer(item.marker);
  });

  $("#visibleCount").textContent = visible.length;
  const container = $("#results");

  if (!visible.length) {
    container.innerHTML = '<div class="empty-state">' +
      (query ? "Brak pasujących miejsc. Spróbuj innej nazwy lub włącz więcej kategorii." : "Brak widocznych punktów.") +
      "</div>";
    return;
  }

  const sorted = visible.slice().sort((a, b) => a.name.localeCompare(b.name, "pl")).slice(0, 40);
  container.innerHTML = sorted.map(item =>
    '<button class="result-card" type="button" data-key="' + item.type + ":" + item.id + '">' +
    "<strong>" + escapeHtml(item.name) + "</strong>" +
    "<small>" + META[item.category].icon + " " + escapeHtml(META[item.category].label) + "</small>" +
    "</button>"
  ).join("");

  $$(".result-card").forEach(card => {
    card.addEventListener("click", () => {
      const item = items.find(x => x.type + ":" + x.id === card.dataset.key);
      if (!item) return;
      map.setView([item.lat, item.lon], Math.max(map.getZoom(), 15), { animate: true });
      item.marker.openPopup();
      closeSidebarMobile();
    });
  });
}

function setStatus(type, text) {
  const status = $("#status");
  status.innerHTML = '<span class="status-dot ' + type + '"></span><span>' + escapeHtml(text) + "</span>";
}

function clearData() {
  Object.values(layers).forEach(layer => layer.clearLayers());
  items = [];
  routes = [];
  updateCounts();
  renderResults();
}

async function loadData() {
  $("#retryBtn").classList.add("hidden");
  setStatus("loading", "Ładowanie miejsc i tras z OpenStreetMap…");
  clearData();

  try {
    const [places, boundary] = await Promise.all([
      overpass(placesQuery),
      overpass(boundaryQuery).catch(() => ({ elements: [] }))
    ]);

    const seen = new Set();
    (places.elements || []).forEach((element, index) => {
      const key = element.type + ":" + element.id;
      if (seen.has(key)) return;
      seen.add(key);

      if (element.type === "relation" && element.tags?.route === "bicycle") {
        addRoute(element, index);
      } else {
        addPlace(element);
      }
    });

    if (boundaryLayer) map.removeLayer(boundaryLayer);
    drawBoundary(boundary);
    updateCounts();
    applyFilters();

    const total = items.length;
    setStatus("ok", "Załadowano " + total + " miejsc i " + routes.length + " tras rowerowych.");
  } catch (error) {
    console.error(error);
    setStatus("error", "Nie udało się pobrać danych OSM. Spróbuj ponownie za chwilę.");
    $("#retryBtn").classList.remove("hidden");
  }
}

function toggleCategory(button) {
  button.classList.toggle("active");
  applyFilters();
}

$$(".filter").forEach(button => {
  button.addEventListener("click", () => toggleCategory(button));
});

$("#selectAll").addEventListener("click", () => {
  $$(".filter").forEach(button => button.classList.add("active"));
  applyFilters();
});

$("#clearAll").addEventListener("click", () => {
  $$(".filter").forEach(button => button.classList.remove("active"));
  applyFilters();
});

$("#searchInput").addEventListener("input", event => {
  $(".search").classList.toggle("has-value", !!event.target.value);
  applyFilters();
});

$("#clearSearch").addEventListener("click", () => {
  $("#searchInput").value = "";
  $(".search").classList.remove("has-value");
  applyFilters();
  $("#searchInput").focus();
});

$("#retryBtn").addEventListener("click", loadData);

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

$("#locateBtn").addEventListener("click", () => {
  if (!navigator.geolocation) {
    showToast("Ta przeglądarka nie obsługuje lokalizacji.");
    return;
  }

  navigator.geolocation.getCurrentPosition(position => {
    const lat = position.coords.latitude;
    const lon = position.coords.longitude;

    if (userMarker) map.removeLayer(userMarker);
    userMarker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: "",
        html: '<div class="user-pin"></div>',
        iconSize: [18, 18],
        iconAnchor: [9, 9]
      })
    }).addTo(map).bindPopup("Twoja lokalizacja");

    map.setView([lat, lon], 14, { animate: true });
    userMarker.openPopup();
  }, () => showToast("Nie udało się pobrać lokalizacji."));
});

function openSidebarMobile() {
  $("#sidebar").classList.add("open");
  $("#filtersBtn").setAttribute("aria-expanded", "true");
}
function closeSidebarMobile() {
  $("#sidebar").classList.remove("open");
  $("#filtersBtn").setAttribute("aria-expanded", "false");
}
$("#filtersBtn").addEventListener("click", () => {
  $("#sidebar").classList.contains("open") ? closeSidebarMobile() : openSidebarMobile();
});
$("#closeSidebar").addEventListener("click", closeSidebarMobile);

loadData();