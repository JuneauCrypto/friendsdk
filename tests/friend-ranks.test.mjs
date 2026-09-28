import assert from 'node:assert/strict';
import test from 'node:test';
import { readFriendRanks, readFriendArt, compareFriendRank, friendRewardRate } from '../dist/friend-ranks.js';

const MANAGER = '0x4444444444444444444444444444444444444444';
const client = tiers => ({
  async readContract(call) {
    if (call.functionName === 'activationManager') return MANAGER;
    if (call.functionName === 'positions') {
      assert.equal(call.address, MANAGER);
      const t = tiers.get(call.args[1]);
      if (t === 'fail') throw new Error('rpc');
      return t === undefined ? [0, 0n] : [t, 10n];
    }
    if (call.functionName === 'tokenURI') {
      const image = call.args[0] === 1n ? 'data:image/svg+xml;base64,PHN2Zy8+' : 'https://example.com/x.png';
      return 'data:application/json;base64,' + Buffer.from(JSON.stringify({ image })).toString('base64');
    }
    throw new Error('unexpected ' + call.functionName);
  },
});

test('ranks Friends by reward rate, best effort, never failing discovery', async () => {
  const friends = [{ id: 5n, generation: 2 }, { id: 6n, generation: 1 }, { id: 7n, generation: 1 }, { id: 8n, generation: 1 }];
  const ranks = await readFriendRanks(client(new Map([[5n, 4], [6n, 0], [8n, 'fail']])), friends);
  assert.deepEqual(ranks.map(r => [r.id, r.tier, r.rate]), [[5n, 4, 86062.5], [6n, 0, 175000], [7n, null, 0], [8n, undefined, 0]]);
  const sorted = friends.map(f => ({ ...f, rate: ranks.find(r => r.id === f.id).rate })).sort(compareFriendRank);
  assert.deepEqual(sorted.map(f => f.id), [6n, 5n, 7n, 8n]);
  assert.equal(friendRewardRate(1, 4), 987187.5);
  assert.equal(friendRewardRate(3, null), 0);
});

test('artwork only accepts inline image data', async () => {
  assert.equal(await readFriendArt(client(new Map()), 1n), 'data:image/svg+xml;base64,PHN2Zy8+');
  assert.equal(await readFriendArt(client(new Map()), 2n), null);
});
