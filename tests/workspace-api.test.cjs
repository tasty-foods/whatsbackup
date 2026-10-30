const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

test('workspace preferences persist, reject invalid options, and keep capture settings and secrets intact', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'whatsbackup-workspace-api-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('whatsbackup-workspace-api-'));
    fs.rmSync(root,{recursive:true,force:true});
  });
  const cfg = { PUBLIC_DIR:path.resolve(__dirname,'../public'), DATA_DIR:root, IMAGES_DIR:root, VIDEO_DIR:root, FILES_DIR:root, CLOUD_ROOT:'', APP_HOME:root };
  const moduleLoad = (file, overrides) => {
    const context = { module:{exports:{}}, console, process, Buffer, URL, require:name => name in overrides ? overrides[name] : name.startsWith('./') ? {} : require(name) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'),context);
    return context.module.exports;
  };
  const settings = moduleLoad('settings.js',{'./paths':{DATA_DIR:root}});
  settings.write({captureVideos:false,cloudRoot:'existing-cloud',aiKeyEnc:'private-ciphertext',aiKeysEnc:{provider:'private-ciphertext'}});
  const library = moduleLoad('library.js',{'./paths':{DATA_DIR:root}});
  const createApp = moduleLoad('web.js',{
    './config':cfg,'./paths':{DATA_DIR:root},'./settings':settings,'./library':library,
    './logger':{FILE:path.join(root,'log')},'./store':{get:id=>['located','offline'].includes(id)?{id}:null,listRecords:()=>[],hiddenIds:()=>new Set()},
    './media-locations':{locate:async record=>{
      if(record.id==='offline')throw Error('drive lookup failed');
      return require('../src/media-locations').locate(record,{backup:{localPathFor:async()=>{await new Promise(setImmediate);return path.join(root,'label #1.png');},cloudPathFor:()=>null}});
    }},
    './cleanup':{QUARANTINE_DIR:root},'./media-export':require('../src/media-export'),
  });
  const server=await new Promise(resolve=>{const s=createApp().listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const post=(body,origin=base)=>fetch(base+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});
  const response=await post({uiTheme:'dark',uiDensity:'compact',uiLayout:'list',uiStartView:'convo',uiReduceMotion:true,uiVideoPreview:false,uiShowCaptions:false});
  assert.equal(response.status,200);
  const changed=await response.json();
  assert.deepEqual(changed.rejected,[]);
  assert.equal(changed.restartRequired,false);
  assert.equal(changed.settings.aiKeyEnc,undefined);
  assert.equal(changed.settings.aiKeysEnc,undefined);
  assert.equal(changed.settings.captureVideos,false);
  assert.equal(changed.settings.cloudRoot,'existing-cloud');
  const persisted=await (await fetch(base+'/api/settings')).json();
  assert.equal(persisted.settings.uiLayout,'list');
  assert.equal(persisted.settings.uiVideoPreview,false);
  const invalid=await (await post({uiTheme:'neon',uiLayout:'unknown',uiVideoPreview:'false'})).json();
  assert.deepEqual(invalid.rejected,['uiTheme','uiLayout','uiVideoPreview']);
  assert.equal(invalid.settings.uiTheme,'dark');
  assert.equal((await post({uiTheme:'light'},'https://other.example')).status,403);
  assert.equal(settings.read().uiTheme,'dark');
  const locationResponse=await fetch(base+'/api/media/located/where');
  assert.equal(locationResponse.status,200);
  const location=await locationResponse.json();
  assert.equal(location.local,path.join(root,'label #1.png'));
  assert.equal(typeof location.local,'string'); // Never serialize a Promise or pass it to path.resolve.
  assert.match(location.localLink,/%231\.png$/);
  assert.equal((await fetch(base+'/api/media/missing/where')).status,404);
  assert.equal((await fetch(base+'/api/media/offline/where')).status,503);
  fs.writeFileSync(path.join(root,'mail-attachment.html'),'<script>document.body.textContent="untrusted attachment"</script>');
  const attachment=await fetch(base+'/media/files/mail-attachment.html');
  assert.equal(attachment.status,200);assert.match(attachment.headers.get('content-disposition'),/^attachment;/);assert.match(attachment.headers.get('content-security-policy'),/sandbox/);assert.equal(attachment.headers.get('x-content-type-options'),'nosniff');
  const largeSelection=await fetch(base+'/api/export/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:Array.from({length:3000},(_,i)=>'missing_'+String(i).padEnd(80,'x'))})});
  assert.equal(largeSelection.status,409); // Read the whole selection; do not hit Express's default 100 KB body limit.
});
