const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
function load(name) {
 const source = fs.readFileSync(path.join(__dirname, '../src', name + '.ts'), 'utf8');
 const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
 const m = { exports: {} }; new Function('exports', 'require', 'module', output)(m.exports, require, m); return m.exports;
}
const { chooseLanguage } = load('locale');
const { validRelease } = load('config');
let checks = 0;
function equal(actual, expected) { assert.equal(actual, expected); checks++; }
for (const country of ['CO','MX','BR','AR','PE','CL','UY','EC','CR','PA','VE','BO','PY','DO','PR']) equal(chooseLanguage(country,'America/New_York',null),'es');
for (const country of ['US','CA','GB','ES','IN','AU']) equal(chooseLanguage(country,'America/Bogota',null),'en');
equal(chooseLanguage('CO','America/Bogota','en'),'en');
equal(chooseLanguage('US','America/New_York','es'),'es');
equal(chooseLanguage('','America/Bogota',null),'es');
equal(chooseLanguage('XX','America/Argentina/Buenos_Aires',null),'es');
equal(chooseLanguage('','America/Los_Angeles',null),'en');
equal(chooseLanguage('','Europe/Madrid',null),'en');
equal(chooseLanguage(undefined,'America/Sao_Paulo',null),'es');
const release = { version:'0.1.1',file:'/releases/Openwhispr-0.1.1-arm64.dmg',bytes:123,architecture:'arm64',minimumMacOS:'14.2',sha256:'a'.repeat(64),notarized:false };
equal(validRelease(release),true);
for (const changed of [{file:'https://example.com/app.dmg'}, {file:'/releases/../app.dmg'}, {file:'/releases/app.exe'}, {bytes:0}, {sha256:'abc'}, {architecture:'x64'}, {notarized:undefined}]) equal(validRelease({...release,...changed}),false);
console.log(`${checks} language and download-manifest checks passed`);
