import { readFile, stat } from 'node:fs/promises';
import { saveReview } from './lib/preference-review-store.mjs';

const args=process.argv.slice(2);
if(args.length!==2 || args[0]!=='--local' || args[1].startsWith('--') || process.env.NODE_ENV==='production')throw Error('Use --local <downloaded answer JSON>; offline only');
if((await stat(args[1])).size>65536)throw Error('Answer file exceeds 64 KiB');
const root=new URL('../validation/preference-review/',import.meta.url);
const study=JSON.parse(await readFile(new URL('study.json',root))),protocol=JSON.parse(await readFile(new URL('protocol-private.json',root)));
const result=await saveReview(new URL('answers/',root),study,protocol,JSON.parse(await readFile(args[1],'utf8')));
console.log(JSON.stringify(result));
