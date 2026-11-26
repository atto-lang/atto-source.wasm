import {test} from 'node:test';
import assert from 'node:assert/strict';
import {create_scoped_env_host} from '../src/std-env-host.mjs';
import {create_env_guest_dispatch_v1} from '../src/std-env-guest-dispatch-v1.mjs';

const host = values => create_scoped_env_host({
  values, allow: ['PUBLIC_*'], deny: ['PUBLIC_SECRET'],
  environmentCapability: true
});

test('guest dispatch encodes present, empty, absent and existence distinctly', () => {
  const dispatch = create_env_guest_dispatch_v1(host({
    PUBLIC_NAME: 'guest', PUBLIC_EMPTY: '', PUBLIC_SECRET: 'no'
  }));
  assert.deepEqual(dispatch.dispatch({operation:'get', name:'PUBLIC_NAME'}),
    {tag:'some', value:'guest'});
  assert.deepEqual(dispatch.dispatch({operation:'get', name:'PUBLIC_EMPTY'}),
    {tag:'some', value:''});
  assert.deepEqual(dispatch.dispatch({operation:'get', name:'PUBLIC_MISSING'}),
    {tag:'none'});
  assert.deepEqual(dispatch.dispatch({operation:'has', name:'PUBLIC_EMPTY'}),
    {tag:'bool', value:true});
  assert.deepEqual(dispatch.dispatch({operation:'has', name:'PUBLIC_MISSING'}),
    {tag:'bool', value:false});
});

test('guest may not pass values, permissions, revoke or arbitrary operations', () => {
  const dispatch = create_env_guest_dispatch_v1(host({PUBLIC_NAME:'good'}));
  for (const query of [
    null, [], {}, {operation:'set',name:'PUBLIC_NAME'},
    {operation:'revoke',name:'PUBLIC_NAME'},
    {operation:'get',name:'PUBLIC_NAME',value:'evil'},
    {operation:'get',name:'PUBLIC_NAME',allow:['*']},
    Object.assign(Object.create(null), {operation:'get',name:'PUBLIC_NAME'}),
  ]) {
    const value = dispatch.dispatch(query);
    if (query && Object.getPrototypeOf(query) === null &&
        !Array.isArray(query)) {
      assert.deepEqual(value,{tag:'some',value:'good'});
    } else {
      assert.deepEqual(value, {tag:'error',code:'ENV_INVALID_REQUEST'});
    }
  }
  assert.deepEqual(dispatch.dispatch({operation:'get', name:'PUBLIC_NAME'}),
    {tag:'some',value:'good'});
});

test('scoped deny and coarse deny remain distinct from absence', () => {
  const dispatch = create_env_guest_dispatch_v1(host({PUBLIC_SECRET:'secret'}));
  assert.deepEqual(dispatch.dispatch({operation:'get',name:'PUBLIC_SECRET'}),
    {tag:'error',code:'ENV_PERMISSION_DENIED'});
  assert.deepEqual(dispatch.dispatch({operation:'has',name:'PRIVATE_UNKNOWN'}),
    {tag:'error',code:'ENV_PERMISSION_DENIED'});
  const noCoarse = create_scoped_env_host({
    values:{PUBLIC_NAME:'not visible'},allow:['*'],environmentCapability:false
  });
  assert.deepEqual(create_env_guest_dispatch_v1(noCoarse).dispatch({
    operation:'get',name:'PUBLIC_NAME'
  }), {tag:'error',code:'ENV_PERMISSION_DENIED'});
});

test('invalid keys and forged snapshot objects fail closed without secret echoes', () => {
  assert.throws(()=>create_env_guest_dispatch_v1({
    get:()=>({some:true,value:'forged'}),has:()=>true
  }), /ENV_INVALID_HOST/);
  const dispatch = create_env_guest_dispatch_v1(host({PUBLIC_NAME:'very-secret'}));
  for(const key of ['', 'PATH=evil', '9BAD', 'A'.repeat(129)]) {
    assert.deepEqual(dispatch.dispatch({operation:'get',name:key}),
      {tag:'error',code:'ENV_INVALID_NAME'});
  }
  const evil = {name:'PUBLIC_NAME'};
  Object.defineProperty(evil,'operation',{get(){throw Error('GETTER EXECUTED');}});
  assert.deepEqual(dispatch.dispatch(evil), {tag:'error',code:'ENV_INVALID_REQUEST'});
  assert.deepEqual(dispatch.dispatch({operation:'get',name:'PUBLIC_MISSING'}),
    {tag:'none'});
});

test('revocation remains effective for already constructed guest dispatch', () => {
  const scoped = host({PUBLIC_NAME:'retired'});
  const dispatch = create_env_guest_dispatch_v1(scoped);
  assert.deepEqual(dispatch.dispatch({operation:'get',name:'PUBLIC_NAME'}),
    {tag:'some',value:'retired'});
  assert.equal(scoped.revoke(),true);
  assert.deepEqual(dispatch.dispatch({operation:'get',name:'PUBLIC_NAME'}),
    {tag:'error',code:'ENV_PERMISSION_DENIED'});
  assert.deepEqual(dispatch.dispatch({operation:'has',name:'PUBLIC_NAME'}),
    {tag:'error',code:'ENV_PERMISSION_DENIED'});
});
