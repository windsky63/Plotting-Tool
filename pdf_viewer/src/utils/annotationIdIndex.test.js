import {createAnnotationIdIndex} from './annotationIdIndex';
import {createPageAnnotationIndex} from './pageAnnotationIndex';
import {prepareDraftPageTransfer} from './draftPageTransfer';

test('append does not enumerate or copy the full previous ID table', () => {
  const annotations=Array.from({length:10000},(_,i)=>({id:'id-'+i,page:Math.floor(i/50)+1}));
  const before=createPageAnnotationIndex(annotations);
  const iterator=jest.spyOn(before.byId,Symbol.iterator).mockImplementation(()=>{throw Error('Full ID index copied');});
  const added={id:'new',page:200};
  const after=createPageAnnotationIndex([...annotations,added],before);
  expect(iterator).not.toHaveBeenCalled();
  expect(before.byId.size).toBe(10000);expect(before.byId.has('new')).toBe(false);
  expect(after.byId.size).toBe(10001);expect(after.byId.get('new')).toBe(added);
  expect(after.byId.get('id-0')).toBe(annotations[0]);
});

test('editing, deleting and undo leave old ID and pending draft snapshots unchanged', () => {
  const a={id:'a',page:1,text:'old'},b={id:'b',page:2};
  const before=createPageAnnotationIndex([a,b]);
  const draft=prepareDraftPageTransfer({fileName:'test',annotations:before.annotations,__pageIndex:before});
  const changed={...a,text:'new'};
  const edited=createPageAnnotationIndex([changed,b],before);
  const deleted=createPageAnnotationIndex([b],edited);
  const undone=createPageAnnotationIndex([changed,b],deleted);
  expect(before.byId.get('a')).toBe(a);expect(edited.byId.get('a')).toBe(changed);
  expect(deleted.byId.has('a')).toBe(false);expect(undone.byId.get('a')).toBe(changed);
  expect(draft.payload.annotationPageUpdates[0].annotations[0].text).toBe('old');
  expect(draft.index.byId.get('a').text).toBe('old');
  const delta=prepareDraftPageTransfer({fileName:'test',annotations:undone.annotations,__pageIndex:undone},draft.next);
  expect(delta.payload.annotationPageUpdates.map(p=>p.page)).toEqual([1]);
});

test('lookup and iteration preserve numeric/string distinctions and last duplicate values', () => {
  const a={id:1},b={id:'1'},c={id:1},d={id:NaN};
  const index=createAnnotationIdIndex([a,b,c,d,{page:1}]);
  expect([...index]).toEqual([[1,c],['1',b],[NaN,d]]);
  expect(index.size).toBe(3);expect(index.get(1)).toBe(c);expect(index.get('1')).toBe(b);
  expect([...index.keys()]).toEqual([1,'1',NaN]);expect([...index.values()]).toEqual([c,b,d]);
  const visit=jest.fn();index.forEach(visit);expect(visit).toHaveBeenCalledWith(c,1,index);
});

test('rebuild correctly handles an unchanged last duplicate after an earlier edited duplicate', () => {
  const a={id:'same',page:1},b={id:'same',page:2};
  const before=createPageAnnotationIndex([a,b]);
  const after=createPageAnnotationIndex([{...a,text:'changed'},b],before);
  expect(after.byId.get('same')).toBe(b);
  const appended=createPageAnnotationIndex([...after.annotations,{id:'same',page:3}],after);
  expect(appended.byId.size).toBe(1);expect(appended.byId.get('same').page).toBe(3);
  expect(after.byId.get('same')).toBe(b);
});

test('hundreds of mixed updates match a fresh Map while retaining earlier versions', () => {
  let annotations=Array.from({length:300},(_,i)=>({id:'seed-'+i,page:i%8+1}));
  let index=createPageAnnotationIndex(annotations);
  const snapshots=[];
  for(let i=0;i<300;i++){
    if(i%25===0)snapshots.push({index,expected:new Map(annotations.map(a=>[a.id,a]))});
    if(i%3===0)annotations=[...annotations,{id:'add-'+i,page:i%8+1}];
    else if(i%3===1)annotations=annotations.map((a,n)=>n===i%annotations.length?{...a,page:9,text:String(i)}:a);
    else annotations=annotations.filter((_,n)=>n!==i%annotations.length);
    index=createPageAnnotationIndex(annotations,index);
    expect([...index.byId]).toEqual([...new Map(annotations.map(a=>[a.id,a]))]);
  }
  for(const snapshot of snapshots)expect([...snapshot.index.byId]).toEqual([...snapshot.expected]);
});
