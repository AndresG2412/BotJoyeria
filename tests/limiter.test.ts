import assert from 'node:assert/strict';
import test from 'node:test';
import { createLimiter } from '../src/utils/limiter';

test('el limitador no supera la concurrencia configurada', async () => {
    const limiter = createLimiter(2);
    let active = 0;
    let maximum = 0;

    const task = async (delay: number) => limiter(async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, delay));
        active--;
    });

    await Promise.all([task(20), task(20), task(20), task(20), task(20)]);
    assert.equal(maximum, 2);
    assert.equal(active, 0);
});
