import 'dotenv/config';
import {mailConfiguration} from '../server/services/mail-outbox.mjs';
import {createMailer} from '../server/mail.mjs';
const configuration=mailConfiguration(),result={configuration,verification:'not_requested',messageSent:false};
if(process.argv.includes('--verify')){
 if(!configuration.enabled){result.verification='not_configured';process.exitCode=1;}
 else try{await createMailer().verify();result.verification='smtp_connection_and_auth_passed';}
 catch{result.verification='smtp_connection_or_auth_failed';process.exitCode=1;}
}
console.log(JSON.stringify(result,null,2));
