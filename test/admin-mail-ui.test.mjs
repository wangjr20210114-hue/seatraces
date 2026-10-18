import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {installMailOutboxRoutes} from '../server/services/mail-outbox.mjs';

test('mail administration UI: independent login, rendering, verify, audit, refresh and network recovery',
 {skip:process.env.TEST_MAIL_UI!=='1',timeout:60000},async()=>{
 const f=await iterationFixture({schemas:['mail-outbox-schema.sql']});let browser;
 try{
  let checks=0;
  installMailOutboxRoutes(f.app,{query:f.query,mailer:{enabled:true,configuration:{provider:'tencent_ses',enabled:true,missing:[],invalid:[]},verify:async()=>{checks++;return {domainVerified:true,templatesApproved:true};}}});
  f.app.use(express.static(fileURLToPath(new URL('../public',import.meta.url))));
  const port=await f.start(),origin='http://127.0.0.1:'+port;
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addCookies(f.users.admin.cookie.split('; ').map(s=>{const [name,value]=s.split('=');return {name,value,url:origin};}));
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/admin.html#/mail');
  await page.getByRole('heading',{name:'邮件服务',exact:true}).waitFor();
  assert.match(await page.locator('#admin-content').innerText(),/腾讯云 SES API/);
  await page.getByRole('button',{name:'核验域名与模板'}).click();
  await page.getByText('核验通过',{exact:true}).waitFor();assert.equal(checks,1);
  await page.getByRole('cell',{name:'mail.configuration.verified',exact:true}).waitFor();
  assert.match(await page.locator('#admin-content').innerText(),/未通过|通过/);
  await page.getByRole('button',{name:'核验域名与模板'}).click();
  await page.getByText('请等待30秒后再核验',{exact:true}).waitFor();assert.equal(checks,1);
  await context.setOffline(true);await page.getByRole('button',{name:'刷新 ↻'}).click();
  await page.waitForFunction(()=>document.querySelector('#admin-status').textContent.length>0&&!document.querySelector('#refresh').disabled);
  await context.setOffline(false);await page.getByRole('button',{name:'刷新 ↻'}).click();
  await page.getByRole('heading',{name:'邮件投递记录',exact:true}).waitFor();
  await mkdir(new URL('../validation/tencent-ses',import.meta.url),{recursive:true});
  await page.screenshot({path:fileURLToPath(new URL('../validation/tencent-ses/admin-mail.png',import.meta.url)),fullPage:true});
  assert.deepEqual(errors,[]);
  const anon=await browser.newContext();const p=await anon.newPage();await p.goto(origin+'/admin.html#/mail');
  assert.match(p.url(),/admin-login\.html/);await anon.close();
 }finally{await browser?.close();await f.close();}
});
