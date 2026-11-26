// Candidate fixtures from Rust #331 head cd764de225ddbe664f9d2242f54bdef23e39353b.
// This manifest is an input oracle, not guest execution evidence.
import {createHash} from 'node:crypto';
export const checkedUnwrapFixtures = Object.freeze([
  ['checked-unwrap-option-none','296db8692562dc5d03abb4fc2ece7ece7199b0f7','called Option::unwrap() on a None value\n'],
  ['checked-unwrap-option-some','1941b78ae55a48ced77ff7c7b1b4ca68b63c25f1',''],
  ['checked-unwrap-result-text','046095da5962f024fe0b9cd7d09710e26e5e394c','called Result::unwrap() on an Err value\n'],
  ['checked-unwrap-result-error-cleanup','8e261174e4dfec3c35db5bc30d37ffcec661f71e','cleanup\ncalled Result::unwrap() on an Err value\n'],
  ['checked-unwrap-result-ok','9556e38f355bccd5a5b4c9305f2b706d1559113f','']
].map(Object.freeze));
export function verifyCheckedUnwrapFixture(id, bytes) {
  const entry = checkedUnwrapFixtures.find(row => row[0] === id);
  if (!entry || !(bytes instanceof Uint8Array)) throw new Error('unknown checked unwrap fixture');
  const actual = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
  if (actual !== entry[1]) throw new Error('checked unwrap fixture blob mismatch: ' + id);
  return entry;
}
export function verifyCheckedUnwrapExecution(id, result) {
  const entry = checkedUnwrapFixtures.find(row => row[0] === id);
  if (!entry || result?.ok !== true || result.panic !== 0 || result.value !== 42n || result.stdout !== entry[2])
    throw new Error('checked unwrap guest outcome mismatch: ' + id);
}
