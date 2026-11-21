import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {dashboardScrollScript} from '../src/web-scroll.js';
function browser(options: {storage?:Map<string,string>;path?:string;anchor?:boolean;alert?:boolean;blocked?:boolean}={}) {
  const storage=options.storage??new Map<string,string>(),events=new Map<string,(event:any)=>void>(),calls:unknown[]=[],path=options.path??'/forms';
  class Element {dataset:Record<string,string>={};formTarget='';formAction='';link=false;getAttribute(name:string){return name==='formaction'?this.formAction:name==='formtarget'?this.formTarget:null;}closest(){return this.link?this:null;}}
  class Form extends Element {
    actionAttribute='https://maru.example/forms';targetAttribute='';
    get action(){return this.actionAttribute;}set action(value:string){this.actionAttribute=value;}
    get target(){return this.targetAttribute;}set target(value:string){this.targetAttribute=value;}
    override getAttribute(name:string){return name==='action'?this.actionAttribute:name==='target'?this.targetAttribute:super.getAttribute(name);}
  }
  const node=(id:string)=>({scrollIntoView:(value:any)=>calls.push({id,...value})});
  const context={URL,Element,HTMLFormElement:Form,Date,JSON,Number,scrollY:1450,location:{origin:'https://maru.example',pathname:path,href:'https://maru.example'+path+'?edit=abc'},
    document:{readyState:'complete',addEventListener:(name:string,fn:(e:any)=>void)=>events.set(name,fn),querySelector:()=>options.alert?node('alert'):null,getElementById:(id:string)=>options.anchor?node(id):null},
    window:{scrollTo:(value:any)=>calls.push(value)},requestAnimationFrame:(fn:()=>void)=>fn(),
    sessionStorage:{getItem:(key:string)=>{if(options.blocked)throw new Error('blocked');return storage.get(key)??null;},setItem:(key:string,value:string)=>{if(options.blocked)throw new Error('blocked');storage.set(key,value);},removeItem:(key:string)=>{if(options.blocked)throw new Error('blocked');storage.delete(key);}},
  };
  runInNewContext(dashboardScrollScript,context);
  return {storage,events,calls,context,Form,Element};
}
test('same-page submit restores scroll once after redirect and consumes the stored position',()=>{
  const b=browser();b.events.get('submit')!({target:new b.Form(),submitter:new b.Element()});assert.ok(b.storage.has('maru-scroll-once'));
  const next=browser({storage:b.storage});assert.equal((next.calls[0] as any).top,1450);assert.equal(b.storage.size,0);assert.equal(browser({storage:b.storage}).calls.length,0);
});
test('question add or move restores the requested card rather than the old offset',()=>{
  const b=browser(),button=new b.Element();button.dataset.scrollAnchor='question-6';b.events.get('submit')!({target:new b.Form(),submitter:button});
  const next=browser({storage:b.storage,anchor:true});assert.equal((next.calls[0] as any).id,'question-6');
});
test('validation errors remain visible even when an action requested a question anchor',()=>{
  const b=browser(),button=new b.Element();button.dataset.scrollAnchor='question-2';b.events.get('submit')!({target:new b.Form(),submitter:button});
  const next=browser({storage:b.storage,anchor:true,alert:true});assert.equal((next.calls[0] as any).id,'alert');
});
test('different pages, stale records and malformed storage never restore an unrelated offset',()=>{
  for(const data of [{path:'/settings',y:1450,at:Date.now()},{path:'/forms',y:1450,at:Date.now()-40000},{path:'/forms',y:-1,at:Date.now()},{path:'/forms',y:1450,at:Date.now()+40000}]){
    const storage=new Map([['maru-scroll-once',JSON.stringify(data)]]);assert.equal(browser({storage}).calls.length,0);assert.equal(storage.size,0);
  }
  assert.equal(browser({storage:new Map([['maru-scroll-once','not JSON']])}).calls.length,0);
});
test('unavailable browser storage leaves normal forms working',()=>{
  const b=browser({blocked:true});assert.doesNotThrow(()=>b.events.get('submit')!({target:new b.Form(),submitter:new b.Element()}));
});
test('normal link navigation clears a pending restore and other-tab forms do not save one',()=>{
  const b=browser(),form=new b.Form();b.events.get('submit')!({target:form,submitter:new b.Element()});
  const link=new b.Element();link.link=true;b.events.get('click')!({target:link});assert.equal(b.storage.size,0);
  form.target='_blank';b.events.get('submit')!({target:form,submitter:new b.Element()});assert.equal(b.storage.size,0);
});
test('same-page GET filters and nested POST actions preserve position, unrelated actions do not',()=>{
  const b=browser({path:'/settings'}),form=new b.Form();form.action='https://maru.example/settings/test-log';b.events.get('submit')!({target:form,submitter:new b.Element()});assert.equal(JSON.parse(b.storage.get('maru-scroll-once')!).path,'/settings');
  form.action='https://maru.example/auth/logout';b.events.get('submit')!({target:form,submitter:new b.Element()});assert.equal(b.storage.size,0);
});

for(const name of ['HTMLButtonElement','RadioNodeList'])test('Save preserves position when action is masked by '+name,()=>{
  const b=browser(),form=new b.Form();
  // Actual HTML forms expose named controls before native properties. Save/Publish
  // buttons named "action" therefore mask the native URL with a control or collection.
  Object.defineProperty(form,'action',{value:{toString:()=>'[object '+name+']'}});
  b.events.get('submit')!({target:form,submitter:new b.Element()});
  assert.ok(b.storage.has('maru-scroll-once'));const next=browser({storage:b.storage});assert.equal((next.calls[0] as any).top,1450);
});
test('fields named target cannot falsely mark a same-page submit as another-tab navigation',()=>{
  const b=browser(),form=new b.Form();Object.defineProperty(form,'target',{value:{toString:()=>'[object RadioNodeList]'}});
  b.events.get('submit')!({target:form,submitter:new b.Element()});assert.ok(b.storage.has('maru-scroll-once'));
});
test('button target overrides and external destinations still skip restoration',()=>{
  const b=browser(),form=new b.Form(),button=new b.Element();button.formTarget='_blank';b.events.get('submit')!({target:form,submitter:button});assert.equal(b.storage.size,0);
  button.formTarget='';form.action='https://other.example/forms';b.events.get('submit')!({target:form,submitter:button});assert.equal(b.storage.size,0);
});
test('add-question button action and anchor still work when the form action property is masked',()=>{
  const b=browser(),form=new b.Form(),button=new b.Element();Object.defineProperty(form,'action',{value:{toString:()=>'[object RadioNodeList]'}});button.formAction='/forms?edit=abc#question-6';button.dataset.scrollAnchor='question-6';
  b.events.get('submit')!({target:form,submitter:button});const next=browser({storage:b.storage,anchor:true});assert.equal((next.calls[0] as any).id,'question-6');
});
