import {test,expect,signIn} from '../fixtures.mjs';
test('INTEL-ADM-001 官方资料入口与请求链路、邮件缺配置状态',async({page,context,fixture})=>{
 await signIn(context,fixture,'admin',true);await page.goto('/admin.html#quality');
 await page.getByRole('button',{name:'官方资料',exact:true}).click();await expect(page.locator('#quality-panel')).toContainText('故宫');
 await expect(page.locator('#quality-panel')).toContainText('待人工复核');await page.locator('#quality-panel').screenshot({path:'reports/ui/official-facts-admin.png'});
 await page.locator('[data-section="tasks"]').click();await page.getByRole('button',{name:'请求链路与邮件',exact:true}).click();
 await expect(page.locator('#admin-content')).toContainText('邮件投递');await expect(page.locator('#admin-content')).toContainText('尚未配置');
 const view=page.getByRole('button',{name:'查看链路'}).first();
 if(await view.count()){await view.click();await expect(page.locator('#admin-content')).toContainText('进程 RSS');await expect(page.locator('#admin-content')).toContainText('请求编号');}
 await page.locator('#admin-content').screenshot({path:'reports/ui/request-traces-admin.png'});
});
