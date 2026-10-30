'use strict';
function createVault({settings,safeStorage,field='gmailTokensEnc'}) {
  if(!['gmailTokensEnc','googlePhotosTokensEnc'].includes(field))throw Error('Unsupported credential store.');
  return async function handle(action,tokens) {
    if(action==='clear'){settings.write({[field]:''});return {ok:true};}
    if(action==='load') {
      const encrypted=settings.read()[field];
      if(!encrypted)return {ok:true,tokens:null};
      try{return {ok:true,tokens:JSON.parse(safeStorage.decryptString(Buffer.from(encrypted,'base64')))};}
      catch(_){return {ok:false,error:'Saved Gmail credentials cannot be read on this Windows account. Connect Gmail again.'};}
    }
    if(action!=='save'||!tokens||typeof tokens!=='object'||Array.isArray(tokens))return {ok:false,error:'Invalid credential request.'};
    if(!safeStorage.isEncryptionAvailable())return {ok:false,error:'Windows secure storage is unavailable. Gmail credentials were not saved.'};
    const text=JSON.stringify(tokens);
    if(text.length>65536)return {ok:false,error:'Invalid credential response.'};
    settings.write({[field]:safeStorage.encryptString(text).toString('base64')});
    return {ok:true};
  };
}
module.exports={createVault};
