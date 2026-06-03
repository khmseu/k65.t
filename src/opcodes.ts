export type AddressingMode =
  | "implied"
  | "accumulator"
  | "immediate"
  | "zeropage"
  | "zeropageX"
  | "zeropageY"
  | "absolute"
  | "absoluteX"
  | "absoluteY"
  | "indirect"
  | "indexedIndirect"
  | "indirectIndexed"
  | "relative";

export const branchMnemonics = new Set([
  "BCC",
  "BCS",
  "BEQ",
  "BMI",
  "BNE",
  "BPL",
  "BVC",
  "BVS",
]);

type OpcodeMap = Record<string, Partial<Record<AddressingMode, number>>>;

export const opcodes: OpcodeMap = {
  ADC: {
    immediate: 0x69,
    zeropage: 0x65,
    zeropageX: 0x75,
    absolute: 0x6d,
    absoluteX: 0x7d,
    absoluteY: 0x79,
    indexedIndirect: 0x61,
    indirectIndexed: 0x71,
  },
  AND: {
    immediate: 0x29,
    zeropage: 0x25,
    zeropageX: 0x35,
    absolute: 0x2d,
    absoluteX: 0x3d,
    absoluteY: 0x39,
    indexedIndirect: 0x21,
    indirectIndexed: 0x31,
  },
  ASL: {
    accumulator: 0x0a,
    zeropage: 0x06,
    zeropageX: 0x16,
    absolute: 0x0e,
    absoluteX: 0x1e,
  },
  BCC: { relative: 0x90 },
  BCS: { relative: 0xb0 },
  BEQ: { relative: 0xf0 },
  BMI: { relative: 0x30 },
  BNE: { relative: 0xd0 },
  BPL: { relative: 0x10 },
  BRK: { implied: 0x00 },
  BVC: { relative: 0x50 },
  BVS: { relative: 0x70 },
  BIT: { zeropage: 0x24, absolute: 0x2c },
  CLC: { implied: 0x18 },
  CLD: { implied: 0xd8 },
  CLI: { implied: 0x58 },
  CLV: { implied: 0xb8 },
  CMP: {
    immediate: 0xc9,
    zeropage: 0xc5,
    zeropageX: 0xd5,
    absolute: 0xcd,
    absoluteX: 0xdd,
    absoluteY: 0xd9,
    indexedIndirect: 0xc1,
    indirectIndexed: 0xd1,
  },
  CPX: { immediate: 0xe0, zeropage: 0xe4, absolute: 0xec },
  CPY: { immediate: 0xc0, zeropage: 0xc4, absolute: 0xcc },
  DEC: { zeropage: 0xc6, zeropageX: 0xd6, absolute: 0xce, absoluteX: 0xde },
  DEX: { implied: 0xca },
  DEY: { implied: 0x88 },
  EOR: {
    immediate: 0x49,
    zeropage: 0x45,
    zeropageX: 0x55,
    absolute: 0x4d,
    absoluteX: 0x5d,
    absoluteY: 0x59,
    indexedIndirect: 0x41,
    indirectIndexed: 0x51,
  },
  INC: { zeropage: 0xe6, zeropageX: 0xf6, absolute: 0xee, absoluteX: 0xfe },
  INX: { implied: 0xe8 },
  INY: { implied: 0xc8 },
  JMP: { absolute: 0x4c, indirect: 0x6c },
  JSR: { absolute: 0x20 },
  LDA: {
    immediate: 0xa9,
    zeropage: 0xa5,
    zeropageX: 0xb5,
    absolute: 0xad,
    absoluteX: 0xbd,
    absoluteY: 0xb9,
    indexedIndirect: 0xa1,
    indirectIndexed: 0xb1,
  },
  LDX: {
    immediate: 0xa2,
    zeropage: 0xa6,
    zeropageY: 0xb6,
    absolute: 0xae,
    absoluteY: 0xbe,
  },
  LDY: {
    immediate: 0xa0,
    zeropage: 0xa4,
    zeropageX: 0xb4,
    absolute: 0xac,
    absoluteX: 0xbc,
  },
  LSR: {
    accumulator: 0x4a,
    zeropage: 0x46,
    zeropageX: 0x56,
    absolute: 0x4e,
    absoluteX: 0x5e,
  },
  NOP: { implied: 0xea },
  ORA: {
    immediate: 0x09,
    zeropage: 0x05,
    zeropageX: 0x15,
    absolute: 0x0d,
    absoluteX: 0x1d,
    absoluteY: 0x19,
    indexedIndirect: 0x01,
    indirectIndexed: 0x11,
  },
  PHA: { implied: 0x48 },
  PHP: { implied: 0x08 },
  PLA: { implied: 0x68 },
  PLP: { implied: 0x28 },
  ROL: {
    accumulator: 0x2a,
    zeropage: 0x26,
    zeropageX: 0x36,
    absolute: 0x2e,
    absoluteX: 0x3e,
  },
  ROR: {
    accumulator: 0x6a,
    zeropage: 0x66,
    zeropageX: 0x76,
    absolute: 0x6e,
    absoluteX: 0x7e,
  },
  RTI: { implied: 0x40 },
  RTS: { implied: 0x60 },
  SBC: {
    immediate: 0xe9,
    zeropage: 0xe5,
    zeropageX: 0xf5,
    absolute: 0xed,
    absoluteX: 0xfd,
    absoluteY: 0xf9,
    indexedIndirect: 0xe1,
    indirectIndexed: 0xf1,
  },
  SEC: { implied: 0x38 },
  SED: { implied: 0xf8 },
  SEI: { implied: 0x78 },
  STA: {
    zeropage: 0x85,
    zeropageX: 0x95,
    absolute: 0x8d,
    absoluteX: 0x9d,
    absoluteY: 0x99,
    indexedIndirect: 0x81,
    indirectIndexed: 0x91,
  },
  STX: { zeropage: 0x86, zeropageY: 0x96, absolute: 0x8e },
  STY: { zeropage: 0x84, zeropageX: 0x94, absolute: 0x8c },
  TAX: { implied: 0xaa },
  TAY: { implied: 0xa8 },
  TSX: { implied: 0xba },
  TXA: { implied: 0x8a },
  TXS: { implied: 0x9a },
  TYA: { implied: 0x98 },
};

export function modeSize(mode: AddressingMode): number {
  switch (mode) {
    case "implied":
    case "accumulator":
      return 1;
    case "immediate":
    case "zeropage":
    case "zeropageX":
    case "zeropageY":
    case "indexedIndirect":
    case "indirectIndexed":
    case "relative":
      return 2;
    case "absolute":
    case "absoluteX":
    case "absoluteY":
    case "indirect":
      return 3;
  }
}
