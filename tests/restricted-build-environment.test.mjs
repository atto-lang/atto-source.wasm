import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {restrictedBuildEnvironment} from "../scripts/restricted-build-environment.mjs";

test("compiler and clang child env removes tokens and loader/Node injection", () => {
  const env = restrictedBuildEnvironment({
    PATH: process.env.PATH || "/usr/bin:/bin",
    GITHUB_TOKEN:"secret", ACTIONS_RUNTIME_TOKEN:"secret", AWS_SECRET_ACCESS_KEY:"secret",
    GOOGLE_APPLICATION_CREDENTIALS:"/sensitive/service-account.json",
    NODE_OPTIONS:"--require=/tmp/inject.js", LD_PRELOAD:"/tmp/inject.so",
    DYLD_INSERT_LIBRARIES:"/tmp/inject.dylib", HTTP_PROXY:"http://secret@proxy/"
  });
  assert.equal(Object.isFrozen(env),true);
  for (const name of ["GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "AWS_SECRET_ACCESS_KEY",
                      "GOOGLE_APPLICATION_CREDENTIALS", "NODE_OPTIONS", "LD_PRELOAD",
                      "DYLD_INSERT_LIBRARIES", "HTTP_PROXY"])
    assert.equal(Object.hasOwn(env,name),false,"unexpected child authority: "+name);
  const child=spawnSync(process.execPath,["-e",
    "process.stdout.write(JSON.stringify({github:process.env.GITHUB_TOKEN,options:process.env.NODE_OPTIONS,preload:process.env.LD_PRELOAD,path:process.env.PATH}))"
  ],{env,encoding:"utf8",timeout:5000});
  assert.ifError(child.error);
  assert.equal(child.status,0,child.stderr);
  const actual=JSON.parse(child.stdout);
  assert.equal(actual.github,undefined);
  assert.equal(actual.options,undefined);
  assert.equal(actual.preload,undefined);
  assert.equal(actual.path,env.PATH);
});

test("PATH is read once; invalid control bytes and unbounded values fail closed",()=>{
  let reads=0;
  const adversarial={};
  Object.defineProperty(adversarial,"PATH",{get(){reads++;return reads===1?"/usr/bin:/bin":"/tmp/inject";}});
  assert.equal(restrictedBuildEnvironment(adversarial).PATH,"/usr/bin:/bin");
  assert.equal(reads,1);
  for (const value of ["", null, 23, "a\nb", "a\rb", "a\0b", "z".repeat(8193)])
    assert.throws(()=>restrictedBuildEnvironment({PATH:value}),/PATH/);
  assert.equal(restrictedBuildEnvironment({}).PATH,"/usr/bin:/bin");
});
