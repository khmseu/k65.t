export function evaluateExpression(
  expression: string,
  symbols: ReadonlyMap<string, number>,
  location: number,
): number | null {
  const parser = new ExpressionParser(expression, symbols, location);
  return parser.parse();
}

class ExpressionParser {
  private readonly input: string;
  private readonly symbols: ReadonlyMap<string, number>;
  private readonly location: number;
  private position = 0;

  constructor(input: string, symbols: ReadonlyMap<string, number>, location: number) {
    this.input = input;
    this.symbols = symbols;
    this.location = location;
  }

  parse(): number | null {
    this.skipWhitespace();
    if (this.position >= this.input.length) {
      return null;
    }

    const value = this.parseBitwiseOr();
    if (value === null) {
      return null;
    }

    this.skipWhitespace();
    if (this.position !== this.input.length) {
      return null;
    }

    return value & 0xffff;
  }

  private parseBitwiseOr(): number | null {
    let left = this.parseBitwiseXor();

    while (left !== null) {
      this.skipWhitespace();
      if (!this.consume("|")) {
        break;
      }

      const right = this.parseBitwiseXor();
      if (right === null) {
        return null;
      }

      left = (left | right) & 0xffff;
    }

    return left;
  }

  private parseBitwiseXor(): number | null {
    let left = this.parseBitwiseAnd();

    while (left !== null) {
      this.skipWhitespace();
      if (!this.consume("^")) {
        break;
      }

      const right = this.parseBitwiseAnd();
      if (right === null) {
        return null;
      }

      left = (left ^ right) & 0xffff;
    }

    return left;
  }

  private parseBitwiseAnd(): number | null {
    let left = this.parseAdditive();

    while (left !== null) {
      this.skipWhitespace();
      if (!this.consume("&")) {
        break;
      }

      const right = this.parseAdditive();
      if (right === null) {
        return null;
      }

      left = (left & right) & 0xffff;
    }

    return left;
  }

  private parseAdditive(): number | null {
    let left = this.parseMultiplicative();

    while (left !== null) {
      this.skipWhitespace();
      if (this.consume("+")) {
        const right = this.parseMultiplicative();
        if (right === null) {
          return null;
        }
        left = (left + right) & 0xffff;
        continue;
      }

      if (this.consume("-")) {
        const right = this.parseMultiplicative();
        if (right === null) {
          return null;
        }
        left = (left - right) & 0xffff;
        continue;
      }

      break;
    }

    return left;
  }

  private parseMultiplicative(): number | null {
    let left = this.parseUnary();

    while (left !== null) {
      this.skipWhitespace();
      if (this.consume("*")) {
        const right = this.parseUnary();
        if (right === null) {
          return null;
        }
        left = (left * right) & 0xffff;
        continue;
      }

      if (this.consume("/")) {
        const right = this.parseUnary();
        if (right === null || right === 0) {
          return null;
        }
        left = Math.trunc(left / right) & 0xffff;
        continue;
      }

      if (this.consume("%")) {
        const right = this.parseUnary();
        if (right === null || right === 0) {
          return null;
        }
        left = (left % right) & 0xffff;
        continue;
      }

      break;
    }

    return left;
  }

  private parseUnary(): number | null {
    this.skipWhitespace();

    if (this.consume("+")) {
      return this.parseUnary();
    }

    if (this.consume("-")) {
      const value = this.parseUnary();
      return value === null ? null : (-value) & 0xffff;
    }

    if (this.consume("~")) {
      const value = this.parseUnary();
      return value === null ? null : (~value) & 0xffff;
    }

    return this.parsePrimary();
  }

  private parsePrimary(): number | null {
    this.skipWhitespace();

    if (this.consume("(")) {
      const value = this.parseBitwiseOr();
      this.skipWhitespace();
      if (value === null || !this.consume(")")) {
        return null;
      }
      return value;
    }

    if (this.peek() === "*") {
      this.position += 1;
      return this.location & 0xffff;
    }

    const number = this.parseNumber();
    if (number !== null) {
      return number;
    }

    const identifier = this.parseIdentifier();
    if (identifier !== null) {
      return this.symbols.get(identifier.toUpperCase()) ?? null;
    }

    return null;
  }

  private parseNumber(): number | null {
    const rest = this.input.slice(this.position);
    const hexDollar = rest.match(/^\$([0-9a-f]+)/i);
    if (hexDollar?.[1] !== undefined) {
      this.position += hexDollar[0].length;
      return Number.parseInt(hexDollar[1], 16);
    }

    const hex0x = rest.match(/^0x([0-9a-f]+)/i);
    if (hex0x?.[1] !== undefined) {
      this.position += hex0x[0].length;
      return Number.parseInt(hex0x[1], 16);
    }

    const binary = rest.match(/^%([01]+)/);
    if (binary?.[1] !== undefined) {
      this.position += binary[0].length;
      return Number.parseInt(binary[1], 2);
    }

    const decimal = rest.match(/^[0-9]+/);
    if (decimal?.[0] !== undefined) {
      this.position += decimal[0].length;
      return Number.parseInt(decimal[0], 10);
    }

    return null;
  }

  private parseIdentifier(): string | null {
    const rest = this.input.slice(this.position);
    const match = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (match?.[0] === undefined) {
      return null;
    }

    this.position += match[0].length;
    return match[0];
  }

  private consume(token: string): boolean {
    if (this.input.startsWith(token, this.position)) {
      this.position += token.length;
      return true;
    }

    return false;
  }

  private peek(): string | undefined {
    return this.input[this.position];
  }

  private skipWhitespace(): void {
    while (this.position < this.input.length && /\s/.test(this.input[this.position]!)) {
      this.position += 1;
    }
  }
}