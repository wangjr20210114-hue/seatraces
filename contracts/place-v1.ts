/* 定义统一地点结构，包括坐标、来源、开放时间和参考价格。 */

export type FactStatus = 'unknown' | 'source_reported' | 'derived' | 'verified' | 'conflicting' | 'not_applicable';
export type Category = 'attraction' | 'heritage' | 'nature' | 'leisure' | 'accommodation' | 'food' | 'rest' | 'transport' | 'shopping' | 'settlement' | 'service';
export interface Fact<T> {
  value: T | null;
  status: FactStatus;
  sourceRefs: string[];
  retrievedAt: string | null;
  sourceUpdatedAt: string | null;
  validFrom: string | null;
  validThrough: string | null;
  validityTimeZone: string | null;
  reviewAfter: string | null;
  verification: {method:'official_source_review'|'on_site'|'authorized_feed';at:string;actorRef:string} | null;
  derivation: {ruleVersion:string;inputRefs:string[]} | null;
  alternatives: Array<{value:T;sourceRefs:string[]}>;
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
}
export interface ReferencePrice {
  amount:number;currency:string;unit:'person'|'room_night'|'vehicle'|'visit'|'other';
  audience:string | null;product:string | null;conditions:string | null;
  kind:'published_reference';
}
export interface PlaceV1 {
  schemaVersion:'1.0-draft';
  id:string;
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
    searchUsable:boolean;openingEvaluable:boolean;navigationReady:'not_evaluated';
  };
  delivery:{status:'live'|'snapshot';cachedAt:string | null;assembledAt:string};
}
