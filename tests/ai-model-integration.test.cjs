const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {AiError}=require('../src/ai/provider');
const {classifyModel}=require('../src/ai/models');

function harness(){
  const prefs={aiProvider:'gemini',aiModel:'gemini-2.5-flash',aiBaseUrl:'https://generativelanguage.googleapis.com/v1beta/openai',aiChain:['openai'],aiChainEnabled:true,aiChainModels:{},aiOpenaiApiMode:'auto',aiOpenaiReasoningEffort:'auto'};
  const writes=[],calls=[],catalogCalls=[],ledger=[];let listedModels=[];
  let completion=async(cfg)=>{calls.push(cfg);const r={text:'Synthetic answer',json:{ok:true},usage:{in:100,out:10},cost:0.001,costCap:0.001};cfg.onUsage?.(r);return r;};
  const deps={
    '../settings':{read:()=>({...prefs}),write:p=>{writes.push(p);Object.assign(prefs,p);}},
    '../store':{},'../messages':{},'../config':{},'./store':{spendCapSince:()=>0,startRun:(...row)=>{ledger.push(row);return ledger.length;},updateRun(){}},'./label':{},'./arrange':{},
    './probe':{probe:async cfg=>{calls.push(cfg);return {reachable:{ok:true},json:{ok:true},vision:{ok:true},visionVerdict:'yes'};}},
    './provider':{AiError,complete:(...args)=>completion(...args)},'./limits':require('../src/ai/limits').create({file:null}),
    './auto-router':require('../src/ai/auto-router'),'./request-meter':require('../src/ai/request-meter'),
    './presets':{PRESETS:{openai:{keyRequired:true,defaultModel:'gpt-5-mini',baseUrl:'https://api.openai.com/v1'},gemini:{keyRequired:true,defaultModel:'gemini-2.5-flash',baseUrl:'https://generativelanguage.googleapis.com/v1beta/openai'},custom:{}}},
    './models':{classifyModel,getModels:async options=>{catalogCalls.push(options);return {ok:true,models:listedModels};}},
  };
  const context={module:{exports:{}},require:name=>{assert.ok(name in deps,'Unexpected dependency '+name);return deps[name];},console:{log(){},warn(){},error(){}},setTimeout,clearTimeout,Buffer};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/ai/index.js'),'utf8'),context);
  const runner=context.module.exports;runner.setKeys({openai:'openai-private-test-key',gemini:'gemini-private-test-key'});
  return {runner,prefs,writes,calls,catalogCalls,ledger,setModels:models=>{listedModels=models;},setCompletion:fn=>{completion=fn;}};
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

test('Auto chooses within OpenAI per request while keeping the manual model and the $10 setting',async()=>{
  const h=harness();Object.assign(h.prefs,{aiProvider:'openai',aiBaseUrl:'https://api.openai.com/v1',aiOpenaiModelMode:'auto',aiModel:'gpt-5-mini',aiMonthlyBudget:10,aiEnabled:true,aiConsent:true});
  h.setModels(['gpt-6-luna','gpt-6.1-terra','gpt-6.1-sol'].map(id=>({id,selectable:true})));
  await h.runner.prepareAutoRouting();
  assert.equal(h.runner.pickProvider({task:'label_image',needsVision:true}).model,'gpt-6-luna');
  assert.equal(h.runner.pickProvider({task:'label_video',needsVision:true}).model,'gpt-6.1-terra');
  assert.equal(h.runner.pickProvider({task:'label_document',needsVision:true,record:{kind:'document',pageCount:12}}).model,'gpt-6.1-sol');
  await h.runner.searchCompletion({schemaName:'search_concepts',user:'closed cupboard'});assert.equal(h.calls.at(-1).model,'gpt-6-luna');
  await h.runner.searchCompletion({schemaName:'archive_answer',user:'Compare the invoices across the year'});assert.equal(h.calls.at(-1).model,'gpt-6.1-sol');
  assert.equal(h.ledger.length,2);assert.equal(h.prefs.aiModel,'gpt-5-mini');assert.equal(h.prefs.aiMonthlyBudget,10);assert.equal(h.writes.length,0);
  assert.equal(h.runner.autoRoutingStatus().routes.length,3);
});

test('Auto does not guess account availability or route paid work when the budget is exhausted',async()=>{
  const h=harness();Object.assign(h.prefs,{aiProvider:'openai',aiBaseUrl:'https://api.openai.com/v1',aiOpenaiModelMode:'auto',aiModel:'gpt-5-mini',aiMonthlyBudget:0.001,aiEnabled:true,aiConsent:true,aiChainEnabled:false});
  await h.runner.prepareAutoRouting();assert.equal(h.runner.pickProvider({task:'label_image'}),null);assert.equal(h.calls.length,0);
  h.setModels([{id:'gpt-6-luna',selectable:true}]);await h.runner.prepareAutoRouting(true);assert.equal(h.runner.pickProvider({task:'label_image'}),null,'Too little budget headroom for another request');
  assert.equal(h.prefs.aiModel,'gpt-5-mini');assert.equal(h.calls.length,0);
});

test('Auto search records a paid failure once without replaying on a stronger model',async()=>{
  const h=harness();Object.assign(h.prefs,{aiProvider:'openai',aiBaseUrl:'https://api.openai.com/v1',aiOpenaiModelMode:'auto',aiModel:'gpt-5-mini',aiMonthlyBudget:10,aiEnabled:true,aiConsent:true});
  h.setModels(['gpt-6-luna','gpt-6.1-terra','gpt-6.1-sol'].map(id=>({id,selectable:true})));
  let requests=0;h.setCompletion(async cfg=>{requests++;cfg.onUsage({usage:{in:100,out:100},cost:0.01,costCap:0.01});const e=new AiError('Paid answer was incomplete',{kind:'length',retryable:false});e.usageCharged=true;throw e;});
  await assert.rejects(h.runner.searchCompletion({schemaName:'search_concepts',user:'closed cupboard'}),/incomplete/);assert.equal(requests,1);assert.equal(h.ledger.length,1);assert.equal(h.ledger[0][0],'search');assert.equal(h.ledger[0][1],'gpt-6-luna');
});

test('a candidate Auto preview checks available routes before saving without changing the manual selection',async()=>{
  const h=harness();h.setModels(['gpt-6-luna','gpt-6.1-terra','gpt-6.1-sol'].map(id=>({id,selectable:true})));
  await h.runner.prepareAutoRouting(false,true);const preview=h.runner.autoRoutingStatus(true);assert.equal(preview.enabled,false);assert.equal(preview.routes[2].model,'gpt-6.1-sol');
  await h.runner.probe({provider:'openai',openaiModelMode:'auto',task:'archive_answer'});assert.equal(h.calls[0].model,'gpt-6.1-sol');assert.equal(h.prefs.aiProvider,'gemini');assert.equal(h.writes.length,0);
});
