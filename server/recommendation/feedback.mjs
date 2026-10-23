/* 校验旅行评价，提取各体验维度的反馈信号。 */

import {z} from 'zod';
import {answerFeatures} from '../social/features.mjs';
const rating=z.number().int().min(1).max(5);
export const tripFeedbackSchema=z.object({rating,experience:z.enum(['plan','trip']).default('plan'),aspects:z.object({
  places:rating.optional(),pace:z.enum(['too_busy','good','too_slow']).optional(),
  walking:z.enum(['too_much','good','too_little']).optional(),
  transport:z.enum(['too_many_transfers','good','too_long']).optional(),
  dining:rating.optional(),stay:rating.optional(),
}).strict().default({})}).strict();

export function feedbackEvidence(feedback){
  const f=tripFeedbackSchema.parse({rating:feedback.rating,experience:feedback.experience,aspects:feedback.aspects}),weight=f.experience==='trip'?3:1,rows=[];
  if(f.aspects.places)rows.push({origin:'places',values:answerFeatures({interests:feedback.interests||[]}),weight:f.experience==='trip'?5:1,sign:(f.aspects.places-3)/2,reason:'place_satisfaction'});
  if(f.aspects.pace==='too_busy')rows.push({origin:'pace',values:{'pace.relaxed':1,'pace.rests':1},weight,reason:'pace_satisfaction'});
  if(f.aspects.pace==='too_slow')rows.push({origin:'pace',values:{'pace.full':1},weight,reason:'pace_satisfaction'});
  if(f.aspects.walking==='too_much')rows.push({origin:'walking',values:{'mobility.few_walking':1},weight,reason:'walking_satisfaction'});
  if(f.aspects.transport==='too_many_transfers')rows.push({origin:'transport',values:{'mobility.few_transfers':1},weight,reason:'transport_satisfaction'});
  return rows;
}
