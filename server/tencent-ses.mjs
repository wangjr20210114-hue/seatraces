import {createHash,createHmac} from 'node:crypto';
import {request} from 'node:https';
import {mailContent,mailOrigin,sesTemplates} from './mail-config.mjs';

const host='ses.tencentcloudapi.com',contentType='application/json; charset=utf-8';
const hash=v=>createHash('sha256').update(v).digest('hex');
const hmac=(key,v)=>createHmac('sha256',key).update(v).digest();
const safeError=(state,code)=>Object.assign(Error(code),{mailDelivery:{state,code}});

// Tencent Cloud TC3 signature, fixed HTTPS endpoint and SES service scope.
export function sesHeaders(env,action,body,timestamp=Math.floor(Date.now()/1000)){
  const date=new Date(timestamp*1000).toISOString().slice(0,10),scope=`${date}/ses/tc3_request`;
  const signedHeaders='content-type;host;x-tc-action';
  const canonical=['POST','/','',`content-type:${contentType}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`,signedHeaders,hash(body)].join('\n');
  const signingKey=hmac(hmac(hmac('TC3'+env.SES_SECRET_KEY,date),'ses'),'tc3_request');
  const signature=hmac(signingKey,['TC3-HMAC-SHA256',timestamp,scope,hash(canonical)].join('\n')).toString('hex');
  return {'Content-Type':contentType,Host:host,'X-TC-Action':action,'X-TC-Version':'2020-10-02',
    'X-TC-Region':env.SES_REGION,'X-TC-Timestamp':String(timestamp),
    Authorization:`TC3-HMAC-SHA256 Credential=${env.SES_SECRET_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`};
}

// No automatic transport retries: SendEmail has no documented idempotency key.
function post(headers,body){
  return new Promise((resolve,reject)=>{
    const req=request({hostname:host,path:'/',method:'POST',headers:{...headers,'Content-Length':Buffer.byteLength(body)}},res=>{
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>512*1024)req.destroy(Error('RESPONSE_TOO_LARGE'));else chunks.push(chunk);});
      res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(chunks).toString('utf8')}));
      res.on('error',reject);
    });
    const deadline=setTimeout(()=>req.destroy(Error('TIMEOUT')),20000);deadline.unref();
    req.on('close',()=>clearTimeout(deadline));req.on('error',reject);req.end(body);
  });
}

export function createSesMailer(env,{postRequest=post,now=()=>Math.floor(Date.now()/1000)}={}){
  const origin=mailOrigin(env.APP_ORIGIN);
  async function call(action,params){
    const sending=action==='SendEmail',body=JSON.stringify(params);let response,data;
    try{response=await postRequest(sesHeaders(env,action,body,now()),body);}
    catch(error){
      const beforeRequest=['ENOTFOUND','EAI_AGAIN','ECONNREFUSED'].includes(error?.code);
      throw safeError(!sending||beforeRequest?'retry':'unknown',sending&&!beforeRequest?'SES_ACCEPTANCE_UNKNOWN':'SES_CONNECTION_FAILED');
    }
    try{data=JSON.parse(response.text).Response;}catch{}
    if(data?.Error&&typeof data.Error.Code!=='string')
      throw safeError(sending?'unknown':'retry',sending?'SES_ACCEPTANCE_UNKNOWN':'SES_INVALID_RESPONSE');
    const code=data?.Error?.Code;
    if(code){
      if(code==='RequestLimitExceeded'||code==='FailedOperation.FrequencyLimit'||code==='FailedOperation.TemporaryBlocked')throw safeError('retry','SES_THROTTLED');
      if(code.startsWith('InternalError'))throw safeError(sending?'unknown':'retry',sending?'SES_ACCEPTANCE_UNKNOWN':'SES_TEMPORARY');
      // Do not copy supplier messages: they can contain addresses or request data.
      const auth=/^(AuthFailure|UnauthorizedOperation|OperationDenied)/.test(code);
      throw safeError('failed',auth?'SES_AUTH_REJECTED':'SES_REQUEST_REJECTED');
    }
    if(response.status!==200||!data||sending&&!data.MessageId)
      throw safeError(sending?'unknown':'retry',sending?'SES_ACCEPTANCE_UNKNOWN':'SES_INVALID_RESPONSE');
    return data;
  }
  return {enabled:true,provider:'tencent_ses',
    async verify(){
      const domain=env.SES_FROM.split('@')[1];
      const identity=await call('GetEmailIdentity',{EmailIdentity:domain});
      if(identity.VerifiedForSendingStatus!==true)throw safeError('failed','SES_DOMAIN_NOT_VERIFIED');
      for(const [purpose,key] of Object.entries(sesTemplates)){
        const result=await call('GetEmailTemplate',{TemplateID:Number(env[key])});
        if(result.TemplateStatus!==0)throw safeError('failed','SES_TEMPLATE_NOT_APPROVED');
        const text=Buffer.from(result.TemplateContent?.Text||'','base64').toString('utf8');
        const html=Buffer.from(result.TemplateContent?.Html||'','base64').toString('utf8');
        const fields=[...(text+'\n'+html).matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(v=>v[1]);
        if(purpose==='password_changed'?fields.length>0:!fields.includes('link')||fields.some(v=>v!=='link'))
          throw safeError('failed','SES_TEMPLATE_VARIABLES_INVALID');
      }
      return {domainVerified:true,templatesApproved:true};
    },
    async send(input){
      const m=mailContent(input,origin);
      await call('SendEmail',{FromEmailAddress:env.SES_FROM,Destination:[m.to],Subject:m.subject,
        Template:{TemplateID:Number(env[sesTemplates[m.purpose]]),TemplateData:JSON.stringify(m.purpose==='password_changed'?{}:{link:m.link})},
        TriggerType:1,Unsubscribe:'0',...(m.messageId?{SmtpMessageId:m.messageId}:{})});
      return {accepted:true};
    },
  };
}
