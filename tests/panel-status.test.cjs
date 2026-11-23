const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../sidepanel/sidepanel.js'),'utf8');
// Exercise the production message listener with rendering dependencies stubbed.
const start = source.indexOf('chrome.runtime.onMessage.addListener((message) => {');
const listener = source.slice(start,source.indexOf('\n});',start)+4);
function setup() {
  let receive;
  const toasts=[], rendered=[];
  vm.runInNewContext(listener,{
    chrome:{runtime:{onMessage:{addListener:fn=>{receive=fn;}}}},currentVideoId:'video',
    normalizeInsights:value=>value,applyInsights:value=>rendered.push(value),
    showToast:(message,type)=>toasts.push({message,type})
  });
  return {receive,toasts,rendered};
}
test('partial completion identifies failed parts instead of announcing success',()=>{
  const s=setup();
  s.receive({type:'INSIGHTS_DONE',videoId:'video',insights:{summary:'Saved',sectionsError:'Output limit',quotesError:'Failed'}});
  assert.equal(s.rendered.length,1);
  assert.deepEqual(s.toasts,[{message:'Finished; retry sections',type:'error'}]);
});
test('complete results show success and other videos cannot change the panel',()=>{
  const s=setup();
  s.receive({type:'INSIGHTS_DONE',videoId:'other',insights:{}});
  assert.equal(s.toasts.length,0);
  s.receive({type:'INSIGHTS_DONE',videoId:'video',insights:{summary:'Done'}});
  assert.deepEqual(s.toasts,[{message:'Summary ready',type:'success'}]);
});

test('summary failure renders successful sibling parts and reports the summary failure', () => {
  const s = setup();
  const insights = { summaryError: 'Stopped after 4 attempts', sections: [{ title: 'Saved' }], notableQuotes: [] };
  s.receive({ type: 'INSIGHTS_DONE', videoId: 'video', insights });
  assert.deepEqual(s.rendered, [insights]);
  assert.deepEqual(s.toasts, [{ message: 'Finished; retry summary', type: 'error' }]);
});
