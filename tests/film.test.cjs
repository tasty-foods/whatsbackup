const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const script = fs.readFileSync('docs/assets/film.js', 'utf8');

function setup(options = {}) {
  const element = () => ({hidden:false,disabled:false,attrs:{},events:{},dataset:{},style:{values:{},setProperty(k,v){this.values[k]=v;},removeProperty(k){delete this.values[k];}},setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,fn){this.events[k]=fn;}});
  const motion=element(),sound=element(),controls=element(),stage=element(),hero=element(),story=element();
  stage.getBoundingClientRect=()=>({left:0,top:0,width:500,height:500});
  const captions=['0','1','2'].map(step=>Object.assign(element(),{dataset:{stepCaption:step}}));
  const buttons=['0','1','2'].map(step=>Object.assign(element(),{dataset:{storyStep:step}}));
  const chapters=['0','1','2'].map(step=>Object.assign(element(),{dataset:{chapter:step}}));
  story.querySelectorAll=()=>captions;
  hero.querySelector=q=>({'.archive-stage':stage,'.experience-controls':controls,'[data-motion-toggle]':motion,'[data-sound-toggle]':sound}[q]);
  const classes=new Set();
  const document={hidden:false,events:{},documentElement:{classList:{toggle(k,v){v?classes.add(k):classes.delete(k);}}},querySelector(q){return q==='.film-hero'?hero:story;},querySelectorAll(q){return q==='[data-story-step]'?buttons:q==='[data-chapter]'?chapters:[];},addEventListener(k,fn){this.events[k]=fn;}};
  const reduced={matches:!!options.reduced,events:{},addEventListener(k,fn){this.events[k]=fn;}};
  const storage={value:options.savedMotion,getItem(){return this.value;},setItem(k,v){this.value=v;}};
  let audioCreated=0,closed=0,stopped=0,observerCallback;
  const param=()=>({value:0,setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}});
  class AudioContext {
    constructor(){audioCreated++;this.currentTime=0;this.destination={};}
    async resume(){}
    async close(){closed++;}
    createGain(){return {gain:param(),connect(){},disconnect(){}};}
    createOscillator(){return {frequency:param(),connect(){},disconnect(){},start(){},stop(){stopped++;}};}
  }
  class IntersectionObserver { constructor(fn){observerCallback=fn;} observe(){} }
  const window={AudioContext,IntersectionObserver,events:{},matchMedia(q){return q.includes('reduced')?reduced:{matches:true};},addEventListener(k,fn){this.events[k]=fn;}};
  vm.runInNewContext(script,{window,document,localStorage:storage,IntersectionObserver,requestAnimationFrame(fn){fn();return 1;},cancelAnimationFrame(){}});
  return {motion,sound,classes,document,reduced,storage,buttons,captions,story,hero,window,observerCallback,audioStats:()=>({audioCreated,closed,stopped})};
}

test('sound is opt-in, can be stopped, and stops when the page is hidden',async()=>{
  const x=setup();
  assert.equal(x.audioStats().audioCreated,0);
  assert.equal(x.sound.attrs['aria-pressed'],undefined); // HTML supplies the initial false value.
  await x.sound.events.click();
  assert.equal(x.sound.attrs['aria-pressed'],'true');
  assert.equal(x.audioStats().audioCreated,1);
  await x.sound.events.click();
  assert.equal(x.sound.attrs['aria-pressed'],'false');
  assert.equal(x.audioStats().closed,1);
  await x.sound.events.click();
  x.document.hidden=true;x.document.events.visibilitychange();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(x.sound.attrs['aria-pressed'],'false');
  assert.equal(x.audioStats().closed,2);
  assert.equal(x.audioStats().stopped,6);
});
test('reduced-motion preferences and a saved pause prevent animation',()=>{
  const x=setup({reduced:true});
  assert.equal(x.motion.disabled,true);
  assert.equal(x.classes.has('motion-on'),false);
  const y=setup({savedMotion:'off'});
  assert.equal(y.classes.has('motion-on'),false);
  y.reduced.matches=true;y.reduced.events.change();
  y.reduced.matches=false;y.reduced.events.change();
  assert.equal(y.classes.has('motion-on'),false);
  y.motion.events.click();
  assert.equal(y.classes.has('motion-on'),true);
  assert.equal(y.storage.value,'on');
  y.motion.events.click();
  assert.equal(y.classes.has('motion-on'),false);
});
test('scroll chapters and buttons keep the archive explanation in sync',()=>{
  const x=setup();
  x.buttons[2].events.click();
  assert.equal(x.story.attrs['data-active'],'2');
  assert.deepEqual(x.captions.map(c=>c.hidden),[true,true,false]);
  assert.deepEqual(x.buttons.map(b=>b.attrs['aria-pressed']),['false','false','true']);
  x.observerCallback([{target:{dataset:{chapter:'1'}},isIntersecting:true}]);
  assert.equal(x.story.attrs['data-active'],'1');
  x.observerCallback([{target:x.hero,isIntersecting:false}]);
  assert.equal(x.classes.has('motion-on'),false);
});
test('leaving the page releases the optional soundtrack',async()=>{
  const x=setup();await x.sound.events.click();
  x.window.events.pagehide();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(x.audioStats().closed,1);
  assert.equal(x.sound.attrs['aria-pressed'],'false');
});
