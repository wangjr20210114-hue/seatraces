/* 提供已核验的官方地点资料。 */

import {query,transaction} from '../db.mjs';
import {createOfficialFacts} from './official-facts.mjs';
export const officialFacts=createOfficialFacts({query,transaction});
