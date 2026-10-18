import 'dotenv/config';
import {mailConfiguration} from '../server/services/mail-outbox.mjs';
import {createMailer} from '../server/mail.mjs';
const configuration=mailConfiguration(),result={configuration,verification:'not_requested',messageSent:false};
if(process.argv.includes('--verify')){
 if(!configuration.enabled){result.verification='not_configured';process.exitCode=1;}
 else try{const checks=await createMailer().verify();result.verification=configuration.provider==='tencent_ses'?'ses_domain_and_templates_passed':'smtp_connection_and_auth_passed';if(configuration.provider==='tencent_ses')result.checks=checks;}
 catch(error){result.verification=configuration.provider==='tencent_ses'?'ses_configuration_verification_failed':'smtp_connection_or_auth_failed';if(/^SES_[A-Z_]+$/.test(error?.mailDelivery?.code))result.errorCode=error.mailDelivery.code;process.exitCode=1;}
}
console.log(JSON.stringify(result,null,2));
