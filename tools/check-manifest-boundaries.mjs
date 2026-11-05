import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from './lib/spawn.mjs';
const script=fileURLToPath(new URL('../presets/fpga-workbench/tools/project/project-bit-manifest.mjs',import.meta.url));
const root=mkdtempSync(join(tmpdir(),'manifest-boundaries-'));
mkdirSync(join(root,'src/rtl'),{recursive:true});mkdirSync(join(root,'bit'));
writeFileSync(join(root,'src/rtl/top.sv'),'module top; endmodule');writeFileSync(join(root,'bit/top.bit'),'BIT');
const run=(...args)=>spawnSync(process.execPath,[script,root,...args],{encoding:'utf8'});
assert.equal(run('--write','--top','top','--json').status,0);
writeFileSync(join(root,'bit/other.bit'),'BIT');writeFileSync(join(root,'outside.bit'),'BIT');
const file=join(root,'bit/top.manifest.json'),valid=JSON.parse(readFileSync(file,'utf8'));
const cases=[
 ['null manifest',()=>writeFileSync(file,'null'),['--top','top'],2],
 ['top mismatch',()=>writeFileSync(file,JSON.stringify({...valid,top:'other',bit:{...valid.bit,file:'other.bit'}})),['--top','top'],2],
 ['escaped bit path',()=>writeFileSync(file,JSON.stringify({...valid,bit:{...valid.bit,file:'../outside.bit'}})),['--top','top'],2],
 ['escaped top',()=>{},['--write','--top','../outside'],2],
 ['null intent',()=>writeFileSync(join(root,'.fpga-build-intent.json'),'null'),['--end','--top','top'],2],
 ['conflicting modes',()=>{},['--begin','--write','--top','top'],2],
 ['unknown option',()=>{},['--begni','--top','top'],2],
];
let failures=0;
for(const [name,setup,args,code]of cases){writeFileSync(file,JSON.stringify(valid));setup();const r=run(...args);try{assert.equal(r.status,code);assert.doesNotMatch(r.stderr??'',/TypeError|at main/);console.log('PASS '+name);}catch{failures++;console.error('FAIL '+name+' status='+r.status+' '+r.stderr);}}
writeFileSync(file,JSON.stringify({...valid,provenance:'constructor'}));
const result=run('--top','top','--json');try{assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout).provenance,'unknown');console.log('PASS prototype key');}catch{failures++;console.error('FAIL prototype key '+result.stdout);}
console.log('Fixtures retained: '+root);process.exitCode=failures?1:0;
