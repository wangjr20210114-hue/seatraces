/* 提交后台登录信息，展示登录结果。 */

const form=document.querySelector('#admin-login-form'),button=document.querySelector('#admin-sign-in'),error=document.querySelector('#admin-login-error');
let busy=false;
form.onsubmit=async event=>{
  event.preventDefault();if(busy)return;
  busy=true;button.disabled=true;button.textContent='正在验证…';error.textContent='';
  const fields=new FormData(form);
  try{
    const response=await fetch('/api/auth/admin/login',{method:'POST',headers:{'Content-Type':'application/json','X-Seatraces':'1'},body:JSON.stringify({username:fields.get('username'),password:fields.get('password')})});
    const data=await response.json();
    if(!response.ok)throw Error(data.error||'登录失败，请重试');
    form.reset();location.replace('/admin.html');
  }catch(e){error.textContent=e instanceof TypeError?'暂时连不上服务，请稍后重试':e.message;form.elements.password.value='';form.elements.password.focus();}
  finally{busy=false;button.disabled=false;button.textContent='登录后台';}
};
void fetch('/api/auth/admin/me',{cache:'no-store'}).then(async response=>{
  if(response.ok&&(await response.json()).access&&!busy)location.replace('/admin.html');
}).catch(()=>{});
