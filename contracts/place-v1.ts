/** Phase-one DESIGN CONTRACT. Not yet deployed or wired into the current API.
 * The smaller live candidate-search API is documented in BACKEND_CANDIDATES.md;
 * it does not claim to implement this full detail/validity/conflict contract.
 * Null expresses unknown; omission is only for category-inapplicable extensions.
 * Source timestamps, import snapshots and real-world validity are distinct.
 */
export type FactStatus = 'unknown' | 'source_reported' | 'derived' | 'verified' | 'conflicting' | 'not_applicable';
export type Category = 'attraction' | 'heritage' | 'nature' | 'leisure' | 'accommodation' | 'food' | 'rest' | 'transport' | 'shopping' | 'settlement' | 'service';
export interface Fact<T> {
  value: T | null;
  status: FactStatus;
  sourceRefs: string[];
  retrievedAt: string | null; // RFC3339: when the source was read, not verification
  sourceUpdatedAt: string | null;
  validFrom: string | null; // inclusive local YYYY-MM-DD
  validThrough: string | null; // inclusive local YYYY-MM-DD
  validityTimeZone: string | null; // IANA; null means validity cannot be resolved
  reviewAfter: string | null; // RFC3339 review target; does not assert closure
  verification: {method:'official_source_review'|'on_site'|'authorized_feed';at:string;actorRef:string} | null;
  derivation: {ruleVersion:string;inputRefs:string[]} | null;
  alternatives: Array<{value:T;sourceRefs:string[]}>; // conflicting => value=null
}
export interface Point {lat:number;lng:number;crs:'WGS84'}
export interface PlaceSource {
  id:string;provider:string;objectId:string | null;url:string | null;
  license:string | null;attribution:string;importId:string | null;
  snapshotAt:string | null;retrievedAt:string | null;
  persistence:'source_dataset'|'licensed_fact'|'request_only'|'unconfirmed';
}
export interface OpeningRule {
  raw:string;syntax:'osm_opening_hours'|'official_text';
  // Derived dated intervals belong to an evaluation response, not the raw rule.
}
export interface ReferencePrice {
  amount:number;currency:string;unit:'person'|'room_night'|'vehicle'|'visit'|'other';
  audience:string | null;product:string | null;conditions:string | null;
  kind:'published_reference'; // live availability/offers are a separate API
}
export interface PlaceV1 {
  schemaVersion:'1.0-draft';
  id:string; // Initially osm:node/..., osm:way/..., osm:relation/...; never a name
  name:string;
  names:Array<{value:string;language:string | null;kind:'primary'|'alias'|'historical'|'brand';sourceRefs:string[]}>;
  classification:{primary:Category;subtype:string | null;travelRoles:Category[];ruleVersion:string};
  location:{
    point:Point;
    pointRole:'mapped_point'|'representative_point_not_entrance'|'verified_entrance'|'unknown';
    entrances:Array<{point:Point;name:string | null;access:Fact<string>;sourceRefs:string[]}>;
    admin:{countryCode:Fact<string>;province:Fact<string>;city:Fact<string>;district:Fact<string>};
    timezone:Fact<string>;
    address:Fact<string>;
  };
  facts:{
    operatingStatus:Fact<'open'|'temporarily_closed'|'permanently_closed'>;
    openingHours:Fact<OpeningRule>;lastEntry:Fact<string>;reservation:Fact<string>;
    fee:Fact<string>;ticketPrice:Fact<ReferencePrice>;stayMinutes:Fact<number>;
    access:Fact<string>;wheelchair:Fact<string>;website:Fact<string>;phone:Fact<string>;
  };
  accommodation?:{
    subtype:Fact<string>;checkIn:Fact<string>;checkOut:Fact<string>;
    amenities:Fact<string[]>;starRating:Fact<{value:number;scheme:string | null}>;
  };
  transport?:{modes:Fact<string[]>;stationCode:Fact<{namespace:string;value:string}>;operator:Fact<string>};
  rest?:{services:Fact<string[]>;drinkingWater:Fact<string>;toiletAccess:Fact<string>};
  relations:Array<{type:'part_of'|'entrance_of'|'possible_same_place';targetId:string;sourceRefs:string[];status:'candidate'|'verified'}>;
  sources:PlaceSource[];
  quality:{
    profile:Category;requiredForSearch:string[];missingForTravel:string[];
    conflicts:string[];needsReview:string[];
    // Request-time quality, not a misleading global "100% complete" score.
    searchUsable:boolean;openingEvaluable:boolean;navigationReady:'not_evaluated';
  };
  delivery:{status:'live'|'snapshot';cachedAt:string | null;assembledAt:string};
}

// Runtime validation rules to implement after field review:
// 1. unknown/not_applicable/conflicting => value=null; confirmed values need sourceRefs.
// 2. derived => derivation required; verified => verification required.
// 3. known country codes use ISO alpha-2; timezone uses an actual IANA identifier.
// 4. coordinates/ranges and all dates validated; validThrough >= validFrom.
// 5. price amounts non-negative, currency ISO-4217, explicit unit; unknown is not zero.
// 6. no declared entrance unless supported; canonical coordinates remain WGS84.
// 7. resolve facts for requested local date; no blind latest-record-wins on conflicts.
// 8. do not persist request_only provider responses in this place record.
// 9. missingFields evaluated per category and use case; not by all possible fields.
