const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProfiles, availableProfiles } = require('../modules/modbus');

test('Modbus Profile Loader — verifies profiles load correctly and have register definitions', () => {
  loadProfiles();
  const profiles = typeof availableProfiles === 'function' ? availableProfiles() : availableProfiles;
  assert.ok(Array.isArray(profiles), 'availableProfiles should be an array');
  assert.ok(profiles.length > 0, 'Should load at least one Modbus profile');

  const deyeProfile = profiles.find(p => p.name && p.name.includes('Deye'));
  assert.ok(deyeProfile, 'Deye Inverter profile should be present');
  assert.ok(Array.isArray(deyeProfile.registers), 'Deye profile should contain registers array');
});
