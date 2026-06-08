import { describe, it } from 'node:test';
import { strict as assert } from 'assert';
import { convertMacro10ToK65 } from './convert.js';

describe('Source location tracking in converter', () => {
  it('should add @source comments to converted lines', () => {
    const input = `; Line 1
LABEL1:
  LDA #$00
  STA $80`;

    const output = convertMacro10ToK65(input);
    const lines = output.split('\n');
    
    // Line 2 should have @source 2
    assert(lines[1]!.includes('@source 2'), `Line 2 should have @source 2, got: ${lines[1]}`);
    
    // Line 3 should have @source 3
    assert(lines[2]!.includes('@source 3'), `Line 3 should have @source 3, got: ${lines[2]}`);
    
    // Line 4 should have @source 4
    assert(lines[3]!.includes('@source 4'), `Line 4 should have @source 4, got: ${lines[3]}`);
  });

  it('should not add @source comments to blank lines', () => {
    const input = `LABEL1:
  LDA #$00

  STA $80`;

    const output = convertMacro10ToK65(input);
    const lines = output.split('\n');
    
    // Line 3 (blank line) should not have @source
    assert(!lines[2]!.includes('@source'), `Blank line should not have @source, got: ${lines[2]}`);
  });

  it('should not add @source comments to existing comments', () => {
    const input = `; This is a comment
LABEL1:`;

    const output = convertMacro10ToK65(input);
    const lines = output.split('\n');
    
    // Line 1 (comment) should not have @source
    assert(!lines[0]!.includes('@source'), `Comment line should not have @source, got: ${lines[0]}`);
  });
});
