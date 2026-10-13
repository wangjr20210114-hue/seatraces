// Existing overseas adapter. Account activation is outside the current phase.
import { request } from "./http.mjs";
import {
  googleRouteRequest,
  googlePlaceRequest,
  GOOGLE_ROUTE_MASK,
  GOOGLE_PLACE_MASK,
} from "../google-maps.mjs";
export async function requestGoogleRoute(a, b, options) {
  const body = googleRouteRequest(a, b, options);
  const result = await request(
    "Google Routes",
    "https://routes.googleapis.com/directions/v2:computeRoutes",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_MAPS_SERVER_KEY,
        "X-Goog-FieldMask": GOOGLE_ROUTE_MASK,
      },
      body: JSON.stringify(body),
    },
  );
  return { body, result };
}
export function requestGooglePlaces(place) {
  return request(
    "Google Places",
    "https://places.googleapis.com/v1/places:searchText",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_MAPS_SERVER_KEY,
        "X-Goog-FieldMask": GOOGLE_PLACE_MASK,
      },
      body: JSON.stringify(googlePlaceRequest(place)),
    },
  );
}
