const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRs232Profiles, availableProfiles } = require('../modules/rs232');

test('RS232 Profile Loader — verifies serial inverter profiles', () => {
  loadRs232Profiles();
  const profiles = typeof availableProfiles === 'function' ? availableProfiles() : availableProfiles;
  assert.ok(Array.isArray(profiles), 'availableProfiles should be an array');
  assert.ok(profiles.length > 0, 'Should load RS232 inverter profiles');

  const voltronic = profiles.find(p => p.name && p.name.includes('Voltronic'));
  assert.ok(voltronic, 'Voltronic profile should be present');
});
