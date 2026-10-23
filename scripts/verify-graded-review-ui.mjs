/* 检查人工评分页面的展示和交互。 */

import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {gradedReviewServer} from './serve-graded-preference-review.mjs';
import {renderGradedReview,validateGradedAnswers} from './lib/graded-preference-review.mjs';
if(process.argv.slice(2).join(' ')!=='--local'||process.env.NODE_ENV==='production')throw Error('Only --local');
const root=new URL('../validation/graded-preference-review/',import.meta.url),qa=new URL('qa/',root);await mkdir(qa,{recursive:true});
const client=await readFile(new URL('lib/graded-preference-client.js',import.meta.url),'utf8');
const study={protocolId:'qa-only-not-human-evidence',primaryCount:2,tasks:[1,2,3].map(i=>({id:'q'+i,scenario:'喜欢园林、慢走',title:'独立测试题 '+i,body:'仅用于测试，不属于人工作答。',tags:[],route:''}))};
const fixture=gradedReviewServer(renderGradedReview(study,client)),real=gradedReviewServer(await readFile(new URL('SeaTraces-旅行内容评价.html',root)));
for(const server of [fixture,real])await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const context=await browser.newContext({acceptDownloads:true,viewport:{width:1000,height:900}}),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+fixture.address().port);await page.locator('#start').click();assert.equal(await page.locator('#next').isDisabled(),true);
 for(let i=0;i<3;i++){
  for(const [d,v] of [['read','yes'],['save','no'],['adopt','unknown']])await page.locator(`button[data-dimension=${d}][data-value=${v}]`).click();
  if(i===0){await page.reload();await page.locator('#start').click();assert.equal(await page.locator('button[aria-pressed=true]').count(),3);}
  await page.locator('#next').click();
 }
 assert.equal(await page.locator('#done').isVisible(),true);
 const downloadPromise=page.waitForEvent('download');await page.locator('#download').click();const download=await downloadPromise;
 const destination=new URL('qa-answer.json',qa);await download.saveAs(fileURLToPath(destination));validateGradedAnswers(study,JSON.parse(await readFile(destination,'utf8')));
 await page.locator('#revise').click();assert.equal(await page.locator('button[aria-pressed=true]').count(),3);
 await page.goto('http://127.0.0.1:'+real.address().port);await page.locator('#start').click();
 await page.screenshot({path:fileURLToPath(new URL('desktop.png',qa)),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:fileURLToPath(new URL('mobile.png',qa)),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,qaAnswersOnly:true,humanAnswersWritten:0,checks:['all dimensions required','reload preserves choices','download parsed and validated','revision preserves choices','desktop and mobile render','no horizontal overflow','no page exceptions']}));
}finally{await browser.close();for(const server of [fixture,real]){server.closeAllConnections();await new Promise(r=>server.close(r));}}
