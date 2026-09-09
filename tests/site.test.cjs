const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const script = fs.readFileSync('docs/assets/site.js','utf8');
const base = 'https://github.com/tasty-foods/whatsbackup/releases/';
function run(release, opts={}) {
  const panels = Array.from({length:4},(_,i)=>({hidden:i!==0}));
  const tabs = panels.map((_,i)=>({tabIndex:i? -1:0,attrs:{'aria-controls':String(i),'aria-selected':String(i===0)},listeners:{},setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k];},addEventListener(k,fn){this.listeners[k]=fn;},focus(){this.focused=true;}}));
  const tablist = {hidden:true,querySelectorAll(){return tabs;}};
  const download = {href:base+'download/v1.4.1/WhatsBackUp-Setup-1.4.1.exe'};
  const version = {textContent:'1.4.1'},size={textContent:'237 MB'},notes={href:base+'tag/v1.4.1'};
  const nodes = {'[data-download]':[download],'[data-version]':[version],'[data-size]':[size],'[data-release]':[notes]};
  const document = {querySelector(){return opts.noTour?null:tablist;},querySelectorAll(q){return nodes[q];},getElementById(id){return panels[Number(id)];}};
  const fetch = opts.fail ? ()=>Promise.reject(new Error('offline')) : async()=>({ok:true,json:async()=>release});
  vm.runInNewContext(script,{document,window:{fetch:opts.noFetch?undefined:fetch},fetch});
  return {panels,tabs,tablist,download,version,size,notes};
}
const flush = ()=>new Promise(resolve=>setImmediate(resolve));
test('tour changes one panel at a time and supports keyboard navigation',()=>{
  const x=run(null,{noFetch:true});
  assert.equal(x.tablist.hidden,false);
  x.tabs[2].listeners.click();
  assert.deepEqual(x.panels.map(p=>p.hidden),[true,true,false,true]);
  assert.equal(x.tabs[2].attrs['aria-selected'],'true');
  let prevented=false;
  x.tabs[2].listeners.keydown({key:'End',preventDefault(){prevented=true;}});
  assert.ok(prevented && x.tabs[3].focused);
  assert.equal(x.tabs[3].tabIndex,0);
  x.tabs[3].listeners.keydown({key:'ArrowRight',preventDefault(){}});
  assert.equal(x.panels[0].hidden,false);
  x.tabs[0].listeners.keydown({key:'ArrowLeft',preventDefault(){}});
  assert.equal(x.panels[3].hidden,false);
  x.tabs[3].listeners.keydown({key:'Home',preventDefault(){}});
  assert.equal(x.panels[0].hidden,false);
});
test('offline release lookup retains the working published installer',async()=>{
  const x=run(null,{fail:true,noTour:true}); await flush();
  assert.equal(x.version.textContent,'1.4.1');
  assert.match(x.download.href,/v1\.4\.1\/WhatsBackUp-Setup-1\.4\.1\.exe$/);
});
test('new stable release updates installer, label, size and notes together',async()=>{
  const url=base+'download/v1.4.2/WhatsBackUp-Setup-1.4.2.exe';
  const x=run({tag_name:'v1.4.2',assets:[{name:'WhatsBackUp-Setup-1.4.2.exe',browser_download_url:url,size:250*1048576}]}); await flush();
  assert.equal(x.download.href,url); assert.equal(x.version.textContent,'1.4.2'); assert.equal(x.size.textContent,'250 MB'); assert.equal(x.notes.href,base+'tag/v1.4.2');
});
test('untrusted installer URLs, prereleases and missing assets retain the fallback',async()=>{
  for(const rel of [{tag_name:'v1.4.2',assets:[{name:'WhatsBackUp-Setup-1.4.2.exe',browser_download_url:'https://example.com/fake.exe'}]},{tag_name:'v1.4.2',prerelease:true,assets:[]},{tag_name:'v1.4.2',assets:[]}]) {
    const x=run(rel);await flush(); assert.equal(x.version.textContent,'1.4.1'); assert.match(x.download.href,/v1\.4\.1\//);
  }
});
