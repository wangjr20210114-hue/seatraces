import { z } from "zod";
import { catalogRequest } from "./catalog.mjs";
import { fromOsm } from "../domain/place-candidate.mjs";
const input = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().int().min(1).max(10000).default(3000),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});
export function createNearbyRecommendations(search = catalogRequest) {
  return async (value) => {
    const query = input.parse(value),
      groups = {};
    for (const category of ["accommodation", "food"]) {
      try {
        const data = await search("/places", { ...query, q: "", category });
        groups[category] = {
          status: data.status,
          items: (data.items || [])
            .map((p) => ({
              ...fromOsm(p, data, category, new Date().toISOString()),
              distanceMeters: Math.round(p.distance_m),
            }))
            .filter((p) => p?.quality.searchUsable),
        };
      } catch (e) {
        groups[category] = {
          status: "unavailable",
          items: [],
          code: e.code || "catalog_unavailable",
        };
      }
    }
    return {
      usage: "nearby_recommendations",
      query,
      groups,
      source: "OpenStreetMap",
      automaticItineraryStops: false,
    };
  };
}
export const nearbyRecommendations = createNearbyRecommendations();
