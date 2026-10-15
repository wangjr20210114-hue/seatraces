import { cityCatalog } from "./city-clusters.mjs";
import { catalogRequest } from "./catalog.mjs";
import {
  clusterWalkPlaces,
  validWalkPlace,
  uniqueWalkPlaces,
} from "../domain/walk-clusters.mjs";
import { metres } from "../../public/citywalk-route.js";
export async function cityWalkCatalog(city) {
  const base = await cityCatalog(city),
    extra = [];
  // Sample central commercial areas too; more nearby categories load lazily as
  // the user chooses an anchor. This is a recommendation pool, not every shop.
  for (const category of ["food", "shopping"]) {
    try {
      const r = await catalogRequest("/places", {
        q: "",
        category,
        lat: city.lat,
        lng: city.lng,
        radius: 1800,
        limit: 60,
      });
      extra.push(...(r.items || []));
    } catch {
      /* Scenic areas remain usable; nearby queries can be retried. */
    }
  }
  const places = uniqueWalkPlaces([...base.places, ...extra]).map((p) => ({
    ...p,
    city: city.name,
    country: city.country,
  }));
  const clusters = clusterWalkPlaces(places),
    included = new Set(clusters.flatMap((g) => g.members.map((p) => p.id)))
      .size;
  return {
    city,
    clusters,
    boundary: base.boundary,
    coverage: {
      ...base.coverage,
      commercialScope: "central_sample_and_on_demand_650m",
    },
    inventory: {
      sourcePlaces: places.length,
      clusteredPlaces: included,
      isolatedPlaces: places.length - included,
    },
    algorithm: "walk-cluster/1",
  };
}
export async function nearbyWalkPlaces(anchor, city, search = catalogRequest) {
  const map = new Map();
  for (const category of ["scenic", "food", "shopping"]) {
    const r = await search("/places", {
      q: "",
      category,
      lat: anchor.lat,
      lng: anchor.lng,
      radius: 650,
      limit: 40,
    });
    if (!["live", "snapshot"].includes(r.status))
      throw Object.assign(Error("附近地点暂时无法加载"), { status: 503 });
    for (const p of r.items || [])
      if (validWalkPlace(p) && metres(anchor, p) <= 650)
        map.set(p.id, { ...p, city: city.name, country: city.country });
  }
  return uniqueWalkPlaces(
    [...map.values()].sort(
      (a, b) =>
        metres(anchor, a) - metres(anchor, b) || a.id.localeCompare(b.id),
    ),
  );
}
