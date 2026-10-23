/* 验证头像上传和显示。 */

import sharp from 'sharp';
import {test,expect,signIn,get} from '../fixtures.mjs';
import {check} from '../cases.mjs';

test.beforeEach(async({context,fixture})=>signIn(context,fixture));

check('ME-006',async({page})=>{
  await page.goto('/#/account');
  await expect(page.locator('#avatar-file')).toBeAttached();
  for(const [format,mime] of [['png','image/png'],['jpeg','image/jpeg'],['webp','image/webp']]){
    const image=await sharp({create:{width:320,height:180,channels:3,background:'#31b49c'}}).toFormat(format).toBuffer();
    const uploaded=page.waitForResponse(r=>r.url().includes('/api/me/avatar')&&r.request().method()==='PUT').catch(()=>null);
    await page.locator('#avatar-file').setInputFiles({name:'avatar.'+format,mimeType:mime,buffer:image});
    await expect(page.locator('#profile-message')).toHaveText('头像已保存');
    const reply=await uploaded;expect(reply).not.toBeNull();expect(reply.status()).toBe(200);
    const response=await page.request.get((await get(page,'/api/me')).user.avatarUrl);
    expect(response.headers()['content-type']).toContain('image/webp');
    const info=await sharp(await response.body()).metadata();
    expect([info.width,info.height,info.format]).toEqual([256,256,'webp']);
    await expect(page.locator('#avatar-preview img')).toBeVisible();
    await expect(page.locator('#avatar-preview img')).toHaveJSProperty('naturalWidth',256);
    await page.reload();
    await expect(page.locator('#avatar-preview img')).toBeVisible();
    await expect(page.locator('#avatar-preview img')).toHaveJSProperty('naturalWidth',256);
  }
},'partial','实际浏览器选择 PNG/JPEG/WebP，经解码、裁剪、真实上传及数据库保存，刷新可读取；系统文件选择器与真机另验收');

test('invalid avatar reports a readable error without replacing the saved image; retry works',async({page})=>{
  await page.goto('/#/account');
  const before=(await get(page,'/api/me')).user.avatarUrl;
  let writes=0;
  page.on('request',r=>{if(r.url().includes('/api/me/avatar')&&r.method()==='PUT')writes++;});
  await page.locator('#avatar-file').setInputFiles({name:'broken.png',mimeType:'image/png',buffer:Buffer.from('not an image')});
  await expect(page.locator('#profile-message')).toContainText('图片无法读取');
  expect(writes).toBe(0);
  expect((await get(page,'/api/me')).user.avatarUrl).toBe(before);
  await expect(page.locator('#upload-avatar')).toBeEnabled();
  expect(await page.locator('#avatar-file').inputValue()).toBe('');
  const image=await sharp({create:{width:40,height:60,channels:3,background:'#ffcc33'}}).png().toBuffer();
  await page.locator('#avatar-file').setInputFiles({name:'good.png',mimeType:'image/png',buffer:image});
  await expect(page.locator('#profile-message')).toHaveText('头像已保存');
  expect(writes).toBe(1);
});

test('avatar decoding also works when the backend directly serves the page',async({page})=>{
  await page.goto('http://127.0.0.1:19887/#/account');
  const image=await sharp({create:{width:60,height:40,channels:3,background:'#4477cc'}}).png().toBuffer();
  await page.locator('#avatar-file').setInputFiles({name:'direct.png',mimeType:'image/png',buffer:image});
  await expect(page.locator('#profile-message')).toHaveText('头像已保存');
  await expect(page.locator('#avatar-preview img')).toHaveJSProperty('naturalWidth',256);
});
