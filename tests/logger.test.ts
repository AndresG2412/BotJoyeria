import assert from 'node:assert/strict';
import test from 'node:test';
import { maskPhone } from '../src/utils/logger';

test('enmascara celulares en los logs y deja ids largos intactos', () => {
    assert.equal(maskPhone('Sesión default_573134532440 → cascada'), 'Sesión default_••••2440 → cascada');
    assert.equal(maskPhone('cliente 3134532440'), 'cliente ••••2440');
    assert.equal(maskPhone('Phone Number ID 1318290941375432'), 'Phone Number ID 1318290941375432');
});
