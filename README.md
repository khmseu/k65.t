# k65.t

`k65.t` is a 6502 multi-pass macro assembler written in TypeScript and Node.js.

## Goals

- Assemble 6502 source into a flat raw binary image.
- Produce a listing with address, output byte count, and source text.
- Emit a symbol table for resolved labels and constants.
- Accept optional labels, optional trailing colons, comma-separated operands, inline semicolon comments, pure comment lines starting with `;` or `*`, and blank lines.

## Recommended VS Code extensions

- `dbaeumer.vscode-eslint` for linting.
- `esbenp.prettier-vscode` for formatting.
- `ms-vscode.vscode-typescript-next` for the TypeScript language service.
- `streetsidesoftware.code-spell-checker` for source text hygiene.

## Scripts

- `npm run build` to compile TypeScript into `dist/`.
- `npm start` to run the assembled CLI entry point.
- `npm test` to run compiled tests.