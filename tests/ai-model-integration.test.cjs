const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {AiError}=require('../src/ai/provider');
const {classifyModel}=require('../src/ai/models');

function harness(){
  const prefs={aiProvider:'gemini',aiModel:'gemini-2.5-flash',aiBaseUrl:'https://generativelanguage.googleapis.com/v1beta/openai',aiChain:['openai'],aiChainEnabled:true,aiChainModels:{},aiOpenaiApiMode:'auto',aiOpenaiReasoningEffort:'auto'};
  const writes=[],calls=[],catalogCalls=[];
  const deps={
    '../settings':{read:()=>({...prefs}),write:p=>{writes.push(p);Object.assign(prefs,p);}},
    '../store':{},'../messages':{},'../config':{},'./store':{},'./label':{},'./arrange':{},
    './probe':{probe:async cfg=>{calls.push(cfg);return {reachable:{ok:true},json:{ok:true},vision:{ok:true},visionVerdict:'yes'};}},
    './provider':{AiError},'./limits':require('../src/ai/limits').create({file:null}),
    './presets':{PRESETS:{openai:{keyRequired:true,defaultModel:'gpt-5-mini',baseUrl:'https://api.openai.com/v1'},gemini:{keyRequired:true,defaultModel:'gemini-2.5-flash',baseUrl:'https://generativelanguage.googleapis.com/v1beta/openai'},custom:{}}},
    './models':{classifyModel,getModels:async options=>{catalogCalls.push(options);return {ok:true,models:[]};}},
  };
  const context={module:{exports:{}},require:name=>{assert.ok(name in deps,'Unexpected dependency '+name);return deps[name];},console:{log(){},warn(){},error(){}},setTimeout,clearTimeout,Buffer};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/ai/index.js'),'utf8'),context);
  const runner=context.module.exports;runner.setKeys({openai:'openai-private-test-key',gemini:'gemini-private-test-key'});
  return {runner,prefs,writes,calls,catalogCalls};
}

test('model catalogue uses the provider saved key and endpoint, ignoring supplied credentials',async()=>{
  const h=harness();
  await h.runner.listModels({provider:'openai',force:true,apiKey:'attacker-key',baseUrl:'https://attacker.example'});
  const request=h.catalogCalls[0];assert.equal(request.apiKey,'openai-private-test-key');assert.equal(request.baseUrl,'https://api.openai.com/v1');assert.equal(request.force,true);assert.equal(h.writes.length,0);
});

test('testing a different provider uses only its own saved credentials without changing the selected model',async()=>{
  const h=harness();await h.runner.probe({provider:'openai',model:'gpt-6-luna',openaiApiMode:'responses',openaiReasoningEffort:'low'});
  assert.equal(h.calls[0].apiKey,'openai-private-test-key');assert.equal(h.calls[0].baseUrl,'https://api.openai.com/v1');assert.equal(h.calls[0].openaiApiMode,'responses');assert.equal(h.calls[0].openaiReasoningEffort,'low');
  assert.equal(h.prefs.aiProvider,'gemini');assert.equal(h.prefs.aiModel,'gemini-2.5-flash');assert.equal(h.writes.length,0);
  await h.runner.probe({provider:'openai',model:'gpt-6-luna',baseUrl:'https://attacker.example'});
  assert.equal(h.calls[1].apiKey,'','A changed address cannot borrow a saved key');
});

test('specialised models and invalid IDs are rejected before a charged probe',async()=>{
  const h=harness();
  for(const model of ['text-embedding-3-small','gpt-image-2','whisper-1','gpt invalid','sk-not-a-model']){
    const result=await h.runner.probe({provider:'openai',model});assert.equal(result.reachable.ok,false);assert.equal(result.errorKind,'model');
  }
  assert.equal(h.calls.length,0);assert.equal(h.writes.length,0);
});

test('fine-tuned OpenAI IDs and chosen compatibility settings survive configuration',()=>{
  const h=harness();Object.assign(h.prefs,{aiProvider:'openai',aiBaseUrl:'https://api.openai.com/v1',aiModel:'ft:gpt-4.1-mini-2025-04-14:org:project:abc123',aiOpenaiApiMode:'responses',aiOpenaiReasoningEffort:'low'});
  const cfg=h.runner.configFor('openai');assert.equal(cfg.model,h.prefs.aiModel);assert.equal(cfg.openaiApiMode,'responses');assert.equal(cfg.openaiReasoningEffort,'low');
  h.prefs.aiModel='vendor/model:free';assert.equal(h.runner.configFor('openai').model,'gpt-5-mini');
});
